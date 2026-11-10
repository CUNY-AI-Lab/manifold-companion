import { beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, JPEG, PDF, addMember, api, call, createProject, createText, invite, json, seedPage, upload } from "./helpers";
import { canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";
import { gatewayEnv } from "./gateway-stub";

let gw: Awaited<ReturnType<typeof gatewayEnv>>;
const GW = () => gw;

const DAVE = canonicalTestSubject("dave");
const EVE = canonicalTestSubject("eve");
type Actor = "owner" | "editor" | "viewer" | "stranger";
const ACTORS: Actor[] = ["owner", "editor", "viewer", "stranger"];
const WHO: Record<Actor, string> = { owner: ALICE, editor: BOB, viewer: CAROL, stranger: DAVE };
const RANK = { stranger: 0, viewer: 1, editor: 2, owner: 3 } as const;

interface Ctx { figureId: string; id: string; inviteId: string; textId: string; pageId: string; pageVersionId: string; hid: string; htextId: string; htmlVersionId: string; textB: string }

async function setup(): Promise<Ctx> {
  const id = await createProject(ALICE, "Matrix");
  await addMember(ALICE, id, BOB, "editor");
  await addMember(ALICE, id, CAROL, "viewer");
  const inv = await invite(ALICE, id, "viewer");
  const textId = await createText(ALICE, id, "T1");
  const textB = await createText(ALICE, id, "T2");
  const pageId = await seedPage(textId, { filename: "a.jpg", ocr: "first", pageNumber: 1, imageBytes: 5 });
  await call(api(`/texts/${textId}/pages/${pageId}`), { method: "POST", body: { text: "second" } });
  const pageVersionId = (await json(await call(api(`/texts/${textId}/versions?type=page`)))).versions[0].id;
  // a second, PDF-to-HTML project for the html routes
  const hid = await createProject(ALICE, "Matrix HTML", { project_type: "pdf_to_html" });
  await addMember(ALICE, hid, BOB, "editor");
  await addMember(ALICE, hid, CAROL, "viewer");
  const htextId = await createText(ALICE, hid, "H1");
  await call(api(`/texts/${htextId}/html`), { method: "PUT", body: { html_content: "<p>one</p>" } });
  await call(api(`/texts/${htextId}/html`), { method: "PUT", body: { html_content: "<p>two</p>" } });
  expect((await upload(api(`/texts/${htextId}/source-pdf`), PDF(), ALICE, { method: "PUT", query: { filename: "s.pdf" } })).status).toBe(201);
  const fig = await upload(api(`/texts/${htextId}/figures`), JPEG(), ALICE, { query: { filename: "f.jpg" } });
  const figureId = (await json(fig)).figure.id as string;
  const htmlVersionId = (await json(await call(api(`/texts/${htextId}/versions?type=html`)))).versions[0].id;
  return { figureId, id, inviteId: inv.id, textId, textB, pageId, pageVersionId, hid, htextId, htmlVersionId };
}

interface Route {
  name: string;
  min: "viewer" | "editor" | "owner";
  ok: number;
  run: (ctx: Ctx, as: string) => Promise<Response>;
}

const JPEG_URI = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const j = (path: string, as: string, method = "GET", body?: unknown) => call(api(path), { as, method, ...(body === undefined ? {} : { body }), env: GW() });

// Every project- or text-scoped route the app exposes. A route added without a row
// here fails the route-coverage test below.
const ROUTES: Route[] = [
  { name: "GET /projects/:id", min: "viewer", ok: 200, run: ({ id }, as) => j(`/projects/${id}`, as) },
  { name: "PUT /projects/:id", min: "owner", ok: 200, run: ({ id }, as) => j(`/projects/${id}`, as, "PUT", { name: "Renamed" }) },
  { name: "DELETE /projects/:id", min: "owner", ok: 200, run: ({ id }, as) => j(`/projects/${id}`, as, "DELETE") },
  { name: "GET /projects/:id/members", min: "viewer", ok: 200, run: ({ id }, as) => j(`/projects/${id}/members`, as) },
  { name: "DELETE /projects/:id/members/:subject", min: "owner", ok: 200, run: ({ id }, as) => j(`/projects/${id}/members/${EVE}`, as, "DELETE") },
  { name: "POST /projects/:id/invites", min: "owner", ok: 201, run: ({ id }, as) => j(`/projects/${id}/invites`, as, "POST", { role: "viewer" }) },
  { name: "GET /projects/:id/invites", min: "owner", ok: 200, run: ({ id }, as) => j(`/projects/${id}/invites`, as) },
  { name: "DELETE /projects/:id/invites/:inviteId", min: "owner", ok: 200, run: ({ id, inviteId }, as) => j(`/projects/${id}/invites/${inviteId}`, as, "DELETE") },
  { name: "GET /projects/:id/texts", min: "viewer", ok: 200, run: ({ id }, as) => j(`/projects/${id}/texts`, as) },
  { name: "POST /projects/:id/texts", min: "editor", ok: 201, run: ({ id }, as) => j(`/projects/${id}/texts`, as, "POST", { name: "New" }) },
  { name: "PUT /projects/:id/texts/reorder", min: "editor", ok: 200, run: ({ id, textId, textB }, as) => j(`/projects/${id}/texts/reorder`, as, "PUT", { textIds: [textB, textId] }) },
  { name: "POST /projects/:id/texts/bulk-status", min: "editor", ok: 200, run: ({ id, textId }, as) => j(`/projects/${id}/texts/bulk-status`, as, "POST", { textIds: [textId], status: "reviewed" }) },
  { name: "POST /projects/:id/texts/bulk-delete", min: "editor", ok: 200, run: ({ id, textB }, as) => j(`/projects/${id}/texts/bulk-delete`, as, "POST", { textIds: [textB] }) },
  { name: "POST /projects/:id/texts/merge", min: "editor", ok: 201, run: ({ id, textId, textB }, as) => j(`/projects/${id}/texts/merge`, as, "POST", { textIds: [textId, textB], name: "Merged" }) },
  { name: "GET /texts/:id", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}`, as) },
  { name: "PUT /texts/:id", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}`, as, "PUT", { name: "Renamed text" }) },
  { name: "DELETE /texts/:id", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}`, as, "DELETE") },
  { name: "GET /texts/:id/pages", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/pages`, as) },
  { name: "PUT /texts/:id/pages/reorder", min: "editor", ok: 200, run: ({ textId, pageId }, as) => j(`/texts/${textId}/pages/reorder`, as, "PUT", { pageIds: [pageId] }) },
  { name: "POST /texts/:id/pages/:pageId", min: "editor", ok: 200, run: ({ textId, pageId }, as) => j(`/texts/${textId}/pages/${pageId}`, as, "POST", { text: "edited" }) },
  { name: "DELETE /texts/:id/pages/:pageId", min: "editor", ok: 200, run: ({ textId, pageId }, as) => j(`/texts/${textId}/pages/${pageId}`, as, "DELETE") },
  { name: "POST /texts/:id/pages", min: "editor", ok: 201, run: ({ textId }, as) => upload(api(`/texts/${textId}/pages`), JPEG(), as, { query: { filename: "new.jpg" } }) },
  { name: "GET /texts/:id/pages/:pageId/image", min: "viewer", ok: 200, run: ({ textId, pageId }, as) => j(`/texts/${textId}/pages/${pageId}/image`, as) },
  { name: "PUT /texts/:id/source-pdf", min: "editor", ok: 201, run: ({ htextId }, as) => upload(api(`/texts/${htextId}/source-pdf`), PDF(), as, { method: "PUT", query: { filename: "n.pdf", replace: "1" } }) },
  { name: "GET /texts/:id/source-pdf", min: "viewer", ok: 200, run: ({ htextId }, as) => j(`/texts/${htextId}/source-pdf`, as) },
  { name: "POST /texts/:id/figures", min: "editor", ok: 201, run: ({ htextId }, as) => upload(api(`/texts/${htextId}/figures`), JPEG(), as, { query: { filename: "g.jpg" } }) },
  { name: "GET /texts/:id/figures", min: "viewer", ok: 200, run: ({ htextId }, as) => j(`/texts/${htextId}/figures`, as) },
  { name: "GET /texts/:id/figures/:figureId", min: "viewer", ok: 200, run: ({ htextId, figureId }, as) => j(`/texts/${htextId}/figures/${figureId}`, as) },
  { name: "DELETE /texts/:id/figures/:figureId", min: "editor", ok: 200, run: ({ htextId, figureId }, as) => j(`/texts/${htextId}/figures/${figureId}`, as, "DELETE") },
  { name: "POST /texts/:id/pages/:pageId/ocr", min: "editor", ok: 200, run: ({ textId, pageId }, as) => j(`/texts/${textId}/pages/${pageId}/ocr`, as, "POST", { overwrite: true }) },
  { name: "POST /texts/:id/parse-page", min: "editor", ok: 200, run: ({ htextId }, as) => j(`/texts/${htextId}/parse-page`, as, "POST", { image: JPEG_URI, page_number: 1 }) },
  { name: "POST /texts/:id/html/cleanup", min: "editor", ok: 200, run: ({ htextId }, as) => j(`/texts/${htextId}/html/cleanup`, as, "POST", { html: "<section data-page=\"1\"><p>x</p></section>" }) },
  { name: "GET /texts/:id/summary", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/summary`, as) },
  { name: "PUT /texts/:id/summary", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/summary`, as, "PUT", { summary: "s" }) },
  { name: "POST /texts/:id/summary", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/summary`, as, "POST", {}) },
  { name: "POST /texts/:id/translate-chunk", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/translate-chunk`, as, "POST", { text: "hola", source_language: "es", target_language: "en" }) },
  { name: "GET /texts/:id/translation", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/translation`, as) },
  { name: "PUT /texts/:id/translation", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/translation`, as, "PUT", { translation: "hello" }) },
  { name: "POST /texts/:id/formula-repair", min: "editor", ok: 200, run: ({ htextId }, as) => j(`/texts/${htextId}/formula-repair`, as, "POST", { formulas: ["x^{2"] }) },
  { name: "GET /projects/:id/export-settings", min: "viewer", ok: 200, run: ({ id }, as) => j(`/projects/${id}/export-settings`, as) },
  { name: "PUT /projects/:id/export-settings", min: "editor", ok: 200, run: ({ id }, as) => j(`/projects/${id}/export-settings`, as, "PUT", { meta: { title: "x" } }) },
  { name: "POST /projects/:id/export", min: "viewer", ok: 200, run: ({ id, textId }, as) => j(`/projects/${id}/export`, as, "POST", { toc: [{ type: "text", textId, label: "T1" }] }) },
  { name: "GET /texts/:id/result", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/result`, as) },
  { name: "GET /texts/:id/compiled", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/compiled`, as) },
  { name: "POST /texts/:id/save", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/save`, as, "POST", { text: "# compiled" }) },
  { name: "GET /texts/:id/html", min: "viewer", ok: 200, run: ({ htextId }, as) => j(`/texts/${htextId}/html`, as) },
  { name: "PUT /texts/:id/html", min: "editor", ok: 200, run: ({ htextId }, as) => j(`/texts/${htextId}/html`, as, "PUT", { html_content: "<p>three</p>" }) },
  { name: "GET /texts/:id/metadata", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/metadata`, as) },
  { name: "POST /texts/:id/metadata", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/metadata`, as, "POST", { dc_title: "T" }) },
  { name: "GET /texts/:id/settings", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/settings`, as) },
  { name: "POST /texts/:id/settings", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/settings`, as, "POST", { temperature: 0.2 }) },
  { name: "DELETE /texts/:id/settings", min: "editor", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/settings`, as, "DELETE") },
  { name: "GET /texts/:id/versions", min: "viewer", ok: 200, run: ({ textId }, as) => j(`/texts/${textId}/versions?type=page`, as) },
  { name: "GET /texts/:id/versions/:versionId", min: "viewer", ok: 200, run: ({ textId, pageVersionId }, as) => j(`/texts/${textId}/versions/${pageVersionId}`, as) },
  { name: "POST /texts/:id/versions/:versionId/revert", min: "editor", ok: 200, run: ({ textId, pageVersionId }, as) => j(`/texts/${textId}/versions/${pageVersionId}/revert`, as, "POST") },
  { name: "POST /texts/:id/split", min: "editor", ok: 201, run: ({ textId }, as) => j(`/texts/${textId}/split`, as, "POST", { splits: [{ name: "A", pages: [1] }, { name: "B", pages: [] }].map((s, i) => (i === 0 ? s : { name: "B", pages: [9] })) }) },
];

beforeAll(async () => {
  gw = await gatewayEnv({
    chat: (body) => {
      const system = JSON.stringify(body.messages[0]);
      if (system.includes("repair TeX")) return { text: '["x^{2}"]' };
      if (system.includes("semantic HTML")) return { text: '<section data-page="1"><p>hello world, long enough to count here</p></section>' };
      return { text: "A fine reply." };
    },
  });
});

describe("authorization matrix: owner / editor / viewer / stranger x every project route", () => {
  for (const route of ROUTES) {
    it(route.name, async () => {
      for (const actor of ACTORS) {
        const ctx = await setup();
        // Seed the member the owner-only removal targets.
        await addMember(ALICE, ctx.id, EVE, "viewer");
        const res = await route.run(ctx, WHO[actor]);
        if (actor === "stranger") {
          expect(res.status, `${route.name} as stranger`).toBe(404);
          expect((await json(res)).error.code).toBe("not_found");
        } else if (RANK[actor] >= RANK[route.min]) {
          expect(res.status, `${route.name} as ${actor}`).toBe(route.ok);
        } else {
          expect(res.status, `${route.name} as ${actor}`).toBe(403);
          expect((await json(res)).error.code).toBe("insufficient_role");
        }
      }
    });
  }

  it("a stranger cannot tell a missing project from someone else's", async () => {
    const { id } = await setup();
    const other = await call(api(`/projects/${id}`), { as: DAVE });
    const missing = await call(api("/projects/00000000-0000-4000-8000-000000000000"), { as: DAVE });
    const malformed = await call(api("/projects/not-an-id"), { as: DAVE });
    expect(other.status).toBe(404);
    const strip = async (r: Response) => ({ ...(await json(r)).error, requestId: undefined });
    expect(await strip(other)).toEqual(await strip(missing));
    expect(malformed.status).toBe(404);
  });

  it("denied writes change nothing", async () => {
    const { id } = await setup();
    for (const as of [CAROL, BOB, DAVE]) {
      await call(api(`/projects/${id}`), { method: "PUT", as, body: { name: "HACKED" } });
      await call(api(`/projects/${id}`), { method: "DELETE", as });
    }
    const res = await call(api(`/projects/${id}`), { as: ALICE });
    expect((await json(res)).project.name).toBe("Matrix");
  });

  it("members: leaving is allowed for non-owners, owners cannot leave or be removed", async () => {
    const { id } = await setup();
    expect((await call(api(`/projects/${id}/members/${ALICE}`), { method: "DELETE", as: ALICE })).status).toBe(409);
    expect((await call(api(`/projects/${id}/members/${ALICE}`), { method: "DELETE", as: BOB })).status).toBe(403);
    expect((await call(api(`/projects/${id}/members/${CAROL}`), { method: "DELETE", as: BOB })).status).toBe(403);
    expect((await call(api(`/projects/${id}/members/${BOB}`), { method: "DELETE", as: BOB })).status).toBe(200);
    expect((await call(api(`/projects/${id}`), { as: BOB })).status).toBe(404);
    expect((await call(api(`/projects/${id}/members/${CAROL}`), { method: "DELETE", as: ALICE })).status).toBe(200);
    expect((await call(api(`/projects/${id}/members/${canonicalTestSubject("nobody")}`), { method: "DELETE", as: ALICE })).status).toBe(404);
    expect((await call(api(`/projects/${id}/members/not-a-subject`), { method: "DELETE", as: ALICE })).status).toBe(404);
  });

  it("member listing shows roles and self-set display names, flags me, and has no email", async () => {
    const { id } = await setup();
    await call(api("/profile"), { method: "PUT", as: BOB, body: { display_name: "Bob B." } });
    const res = await call(api(`/projects/${id}/members`), { as: BOB });
    const { members } = await json(res);
    expect(members.map((m: any) => [m.role, m.me])).toEqual([["owner", false], ["editor", true], ["viewer", false]]);
    expect(members.find((m: any) => m.subject === BOB).display_name).toBe("Bob B.");
    expect(JSON.stringify(members)).not.toMatch(/email|@/);
  });

  it("project listing is scoped to membership", async () => {
    const mine = await createProject(ALICE, "Alice only");
    const shared = await createProject(BOB, "Bob shared");
    await addMember(BOB, shared, ALICE, "viewer");
    const { projects } = await json(await call(api("/projects"), { as: ALICE }));
    const ids = projects.map((p: any) => p.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(shared);
    const bobs = (await json(await call(api("/projects"), { as: BOB }))).projects.map((p: any) => p.id);
    expect(bobs).not.toContain(mine);
    expect((await json(await call(api("/projects"), { as: DAVE }))).projects).toEqual([]);
    expect(projects.find((p: any) => p.id === shared).role).toBe("viewer");
  });

  it("profile routes only ever touch the caller's own profile", async () => {
    await call(api("/profile"), { method: "PUT", as: ALICE, body: { display_name: "Alice" } });
    await call(api("/profile"), { method: "PUT", as: BOB, body: { display_name: "Bob", theme_preference: "dark", onboarded: true } });
    expect((await json(await call(api("/session"), { as: ALICE }))).profile.display_name).toBe("Alice");
    const bob = (await json(await call(api("/session"), { as: BOB }))).profile;
    expect(bob).toEqual({ display_name: "Bob", theme_preference: "dark", onboarded: true });
    // Attempts to name another subject in the body are ignored: there is no such field.
    await call(api("/profile"), { method: "PUT", as: ALICE, body: { display_name: "A2", subject: BOB } });
    expect((await json(await call(api("/session"), { as: BOB }))).profile.display_name).toBe("Bob");
  });

  it("profile validation", async () => {
    for (const body of [{}, { display_name: 5 }, { display_name: "x".repeat(81) }, { display_name: "<b>" }, { theme_preference: "neon" }, { onboarded: "yes" }]) {
      expect((await call(api("/profile"), { method: "PUT", body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("project input validation", async () => {
    for (const body of [{}, { name: "" }, { name: "x".repeat(201) }, { name: "ok", project_type: "x" }, { name: "ok", default_language: "English!" }]) {
      expect((await call(api("/projects"), { method: "POST", body })).status, JSON.stringify(body)).toBe(400);
    }
    const id = await createProject(ALICE, "P", { description: "d", project_type: "pdf_to_html", default_language: "pt-BR" });
    const { project } = await json(await call(api(`/projects/${id}`), { as: ALICE }));
    expect(project).toMatchObject({ description: "d", project_type: "pdf_to_html", default_language: "pt-BR", role: "owner", text_count: 0, member_count: 1 });
    expect((await call(api(`/projects/${id}`), { method: "PUT", body: { name: "" } })).status).toBe(400);
    const cleared = await call(api(`/projects/${id}`), { method: "PUT", body: { description: null } });
    expect((await json(cleared)).project.description).toBeNull();
  });

  it("route coverage: the matrix lists every project- or text-scoped route the app exposes", async () => {
    const { default: app } = await import("../src/app");
    const registered = app.routes
      .filter((r) => (r.path.includes("/projects/:id") || r.path.includes("/texts/:id")) && r.method !== "ALL")
      .map((r) => `${r.method} ${r.path.replace("/manifold-companion/api", "").replace(/\/$/, "")}`);
    const covered = new Set(ROUTES.map((r) => r.name));
    expect(registered.length).toBeGreaterThan(30);
    for (const r of registered) expect(covered.has(r), `route ${r} is not in the authorization matrix`).toBe(true);
    for (const name of covered) expect(registered.includes(name), `matrix row ${name} matches no route`).toBe(true);
  });
});
