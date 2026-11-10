// Property test for DESIGN 6: random batches of concurrent operations on shared
// projects (uploads that succeed or fail, page edits that version, deletes of
// pages, texts and many texts, splits, merges, content writes that grow and
// shrink, ownership transfers, recounts, "delete my data"), and after every
// batch, once all of it has finished:
//   - every counter equals its owner's row bytes plus reservations (none left),
//   - every R2 key a row points at exists, and no object exists that no row
//     points at,
//   - no request failed with a 5xx.
// Seeded, so a failure names a seed that reproduces it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recountStorage } from "../src/storage";
import { ALICE, BOB, CAROL, JPEG, PDF, PNG, addMember, api, call, createProject, createText, makeEnv, objectDrift, storageDrift, upload } from "./helpers";

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(next() * xs.length)] : undefined) };
}

const PEOPLE = [ALICE, BOB, CAROL];

interface State {
  projects: { id: string; owner: string }[];
  texts: { id: string; project: string; pdf: number }[];
  pages: { id: string; text: string; number: number }[];
  figures: { id: string; text: string }[];
}
async function state(): Promise<State> {
  const projects = (await env.DB.prepare("SELECT id, owner_subject AS owner FROM projects").all<{ id: string; owner: string }>()).results;
  const texts = (await env.DB.prepare("SELECT t.id, t.project_id AS project, pr.project_type = 'pdf_to_html' AS pdf FROM texts t JOIN projects pr ON pr.id = t.project_id").all<{ id: string; project: string; pdf: number }>()).results;
  const pages = (await env.DB.prepare("SELECT id, text_id AS text, page_number AS number FROM pages").all<{ id: string; text: string; number: number }>()).results;
  const figures = (await env.DB.prepare("SELECT id, text_id AS text FROM figures").all<{ id: string; text: string }>()).results;
  return { projects, texts, pages, figures };
}

async function setup() {
  const shared = await createProject(ALICE, "Shared");
  await addMember(ALICE, shared, BOB, "editor");
  await addMember(ALICE, shared, CAROL, "editor");
  const carols = await createProject(CAROL, "Carol's");
  await addMember(CAROL, carols, ALICE, "editor");
  // A PDF-to-HTML project: source PDFs replaced, HTML rewritten, figures added and removed.
  const bobs = await createProject(BOB, "Bob's PDFs", { project_type: "pdf_to_html" });
  await addMember(BOB, bobs, ALICE, "editor");
  await createText(BOB, bobs);
  await createText(BOB, bobs);
  for (const [p, owner] of [[shared, ALICE], [shared, ALICE], [carols, CAROL]] as const) {
    const t = await createText(owner, p);
    for (let i = 0; i < 3; i += 1) expect((await upload(api(`/texts/${t}/pages`), JPEG(400 + i), owner, { query: { filename: `s${i}.jpg` } })).status).toBe(201);
  }
}

type Op = () => Promise<Response | void>;

function operations(r: ReturnType<typeof rng>, s: State, e: Awaited<ReturnType<typeof makeEnv>>): Op[] {
  const who = () => r.pick(PEOPLE) as string;
  const text = () => r.pick(s.texts);
  const page = () => r.pick(s.pages);
  const post = (path: string, body: unknown, as = who()) => call(api(path), { method: "POST", body, as, env: e });
  const ops: Op[] = [
    // upload a page; one in five declares more than it sends (fails after reserving)
    async () => {
      const t = text();
      if (!t) return;
      const n = r.int(100, 2500);
      const short = r.next() < 0.2;
      return upload(api(`/texts/${t.id}/pages`), JPEG(short ? 10 : n), who(), { query: { filename: `u${r.int(0, 1e9)}.jpg`, ...(short ? { size: String(n) } : {}) }, env: e });
    },
    // edit a page's text (the old text becomes a version)
    async () => { const p = page(); if (p) return post(`/texts/${p.text}/pages/${p.id}`, { text: `edit ${r.int(0, 1e9)} ${"w".repeat(r.int(0, 600))}` }); },
    async () => { const p = page(); if (p) return call(api(`/texts/${p.text}/pages/${p.id}`), { method: "DELETE", as: who(), env: e }); },
    async () => { const t = text(); if (t) return call(api(`/texts/${t.id}`), { method: "DELETE", as: who(), env: e }); },
    async () => { const p = r.pick(s.projects); if (p) return post(`/projects/${p.id}/texts`, { name: `T${r.int(0, 999)}` }); },
    // split a text into two at a random page
    async () => {
      const t = text();
      if (!t) return;
      const numbers = s.pages.filter((p) => p.text === t.id).map((p) => p.number).sort((a, b) => a - b);
      if (numbers.length < 2) return;
      const cut = r.int(1, numbers.length - 1);
      return post(`/texts/${t.id}/split`, { splits: [{ name: "Left", pages: numbers.slice(0, cut) }, { name: "Right", pages: numbers.slice(cut) }] });
    },
    async () => {
      const p = r.pick(s.projects);
      const ts = s.texts.filter((t) => t.project === p?.id);
      if (!p || ts.length < 2) return;
      return post(`/projects/${p.id}/texts/merge`, { textIds: [r.pick(ts)!.id, r.pick(ts)!.id, ...ts.slice(0, 1).map((t) => t.id)].filter((v, i, a) => a.indexOf(v) === i), name: "Merged" });
    },
    async () => { const p = r.pick(s.projects); if (p) return post(`/projects/${p.id}/texts/bulk-delete`, { textIds: [text()?.id ?? crypto.randomUUID(), text()?.id ?? crypto.randomUUID()].filter((v, i, a) => a.indexOf(v) === i) }); },
    // content that grows and shrinks: translation (unversioned) and compiled text (versioned)
    async () => { const t = text(); if (t) return call(api(`/texts/${t.id}/translation`), { method: "PUT", body: { translation: "t".repeat(r.int(0, 3000)) }, as: who(), env: e }); },
    async () => { const t = text(); if (t) return post(`/texts/${t.id}/save`, { text: `c${r.int(0, 1e9)}`.repeat(r.int(1, 200)) }); },
    // the owner offers the project to another member, who accepts
    async () => {
      const p = r.pick(s.projects);
      if (!p) return;
      const to = r.pick(PEOPLE.filter((x) => x !== p.owner)) as string;
      const res = await call(api(`/projects/${p.id}/transfer`), { method: "POST", body: { subject: to }, as: p.owner, env: e });
      if (res.status !== 201) return res;
      return post(`/transfers/${((await res.json()) as { offer: { id: string } }).offer.id}/accept`, {}, to);
    },
    async () => { await recountStorage(e); },
    // PDF-to-HTML texts
    async () => {
      const t = r.pick(s.texts.filter((x) => x.pdf));
      if (t) return upload(api(`/texts/${t.id}/source-pdf`), PDF(r.int(100, 3000)), who(), { method: "PUT", query: { filename: `s${r.int(0, 1e9)}.pdf` }, env: e });
    },
    async () => {
      const t = r.pick(s.texts.filter((x) => x.pdf));
      if (t) return call(api(`/texts/${t.id}/html`), { method: "PUT", body: { html_content: `<p>${"h".repeat(r.int(1, 2500))}</p>` }, as: who(), env: e });
    },
    async () => {
      const t = r.pick(s.texts.filter((x) => x.pdf));
      if (t) return upload(api(`/texts/${t.id}/figures`), PNG(r.int(100, 1500)), who(), { query: { filename: `f${r.int(0, 1e9)}.png` }, env: e });
    },
    async () => { const f = r.pick(s.figures); if (f) return call(api(`/texts/${f.text}/figures/${f.id}`), { method: "DELETE", as: who(), env: e }); },
  ];
  return ops;
}

describe("storage accounting under random concurrent operations", () => {
  for (const seed of Array.from({ length: 16 }, (_, i) => i + 1)) {
    it(`seed ${seed}: the invariant and the object set hold at every quiescent point`, async () => {
      const r = rng(seed);
      // A tight quota so that some reservations and transfers are refused.
      const e = await makeEnv({ STORAGE_QUOTA_BYTES: "40000", MAX_PROJECT_PAGES: "40" });
      await setup();
      for (let round = 0; round < 12; round += 1) {
        const s = await state();
        const ops = operations(r, s, e);
        const batch: Op[] = Array.from({ length: r.int(2, 6) }, () => ops[r.int(0, ops.length - 1)]!);
        // Late in the run, Carol deletes her data while everything else goes on.
        if (round === 9) batch.push(() => call(api("/me/data"), { method: "DELETE", as: CAROL, env: e, body: { confirm: "delete my data" } }));
        const results = await Promise.all(batch.map((op) => op()));
        const statuses = results.filter((x): x is Response => x instanceof Response).map((x) => x.status);
        expect(statuses.filter((st) => st >= 500), `seed ${seed} round ${round}`).toEqual([]);
        expect(await storageDrift(), `seed ${seed} round ${round}`).toEqual([]);
        expect(await objectDrift(), `seed ${seed} round ${round}`).toEqual({ dangling: [], orphans: [] });
        expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_reservations").first<{ n: number }>())!.n, `seed ${seed} round ${round}`).toBe(0);
        if (round === 10) {
          // A recount at a quiescent point finds nothing to correct.
          expect(await recountStorage(e)).toBe(0);
        }
      }
    });
  }
});
