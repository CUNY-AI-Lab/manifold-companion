import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, addMember, api, call, createProject, createText, json, seedPage } from "./helpers";

// Two editors open the same content; Bob saves first; Alice's save from her
// older copy is refused instead of silently replacing Bob's (DESIGN 6).

const send = (path: string, method: string, body: unknown, as = ALICE) => call(api(path), { method, body, as });

async function shared(type: "image_to_markdown" | "pdf_to_html" = "image_to_markdown") {
  const pid = await createProject(ALICE, "Shared", { project_type: type });
  await addMember(ALICE, pid, BOB, "editor");
  await env.DB.prepare("UPDATE profiles SET display_name = 'Bob B.' WHERE subject = ?1").bind(BOB).run();
  return { pid, tid: await createText(ALICE, pid, "T") };
}

async function expectStale(res: Response, savedBy: string | null) {
  expect(res.status).toBe(409);
  const body = await json(res);
  expect(body.error.code).toBe("edit_conflict");
  expect(typeof body.result.rev).toBe("string");
  expect(typeof body.result.saved_at).toBe("string");
  expect(body.result.saved_by).toBe(savedBy);
  return body.result.rev as string;
}

describe("stale saves: a save from a copy loaded before someone else's save is refused", () => {
  it("page text: rev on read, 409 with who and when, overwrite with the current rev", async () => {
    const { tid } = await shared();
    const pageId = await seedPage(tid, { ocr: "first", pageNumber: 1 });
    const page = async () => (await json(await call(api(`/texts/${tid}`)))).pages[0];
    const aliceLoaded = (await page()).rev;
    const bob = await json(await send(`/texts/${tid}/pages/${pageId}`, "POST", { text: "Bob's", base_rev: (await page()).rev }, BOB));
    expect(bob.rev).toBe((await page()).rev);
    const current = await expectStale(await send(`/texts/${tid}/pages/${pageId}`, "POST", { text: "Alice's", base_rev: aliceLoaded }), "Bob B.");
    expect((await page()).ocr_text).toBe("Bob's");
    expect(current).toBe((await page()).rev);
    expect((await send(`/texts/${tid}/pages/${pageId}`, "POST", { text: "Alice's", base_rev: current })).status).toBe(200);
    expect((await page()).ocr_text).toBe("Alice's");
  });

  it("full text of an image text", async () => {
    const { tid } = await shared();
    const loaded = (await json(await call(api(`/texts/${tid}/compiled`)))).rev;
    expect(loaded).toBe("none");
    const first = await json(await send(`/texts/${tid}/save`, "POST", { text: "v1", base_rev: loaded }));
    const bobBase = (await json(await call(api(`/texts/${tid}/compiled`), { as: BOB }))).rev;
    expect(bobBase).toBe(first.rev);
    const aliceStale = first.rev;
    await send(`/texts/${tid}/save`, "POST", { text: "Bob's v2", base_rev: bobBase }, BOB);
    const current = await expectStale(await send(`/texts/${tid}/save`, "POST", { text: "Alice's v2", base_rev: aliceStale }), "Bob B.");
    expect((await json(await call(api(`/texts/${tid}/compiled`)))).text).toBe("Bob's v2");
    expect((await send(`/texts/${tid}/save`, "POST", { text: "Alice's v2", base_rev: current })).status).toBe(200);
  });

  it("HTML of a PDF text", async () => {
    const { tid } = await shared("pdf_to_html");
    const put = (html: string, base_rev: string, as = ALICE) => send(`/texts/${tid}/html`, "PUT", { html_content: html, base_rev }, as);
    const r1 = await json(await put("<p>one</p>", (await json(await call(api(`/texts/${tid}/html`)))).rev));
    await put("<p>Bob</p>", r1.rev, BOB);
    const current = await expectStale(await put("<p>Alice</p>", r1.rev), "Bob B.");
    expect((await json(await call(api(`/texts/${tid}/html`)))).html_content).toBe("<p>Bob</p>");
    expect(current).toBe((await json(await call(api(`/texts/${tid}/html`)))).rev);
  });

  it("translation (unversioned): the stale save is refused, so the other edit is not lost", async () => {
    const { tid } = await shared();
    const put = (translation: string, base_rev: string, as = ALICE) => send(`/texts/${tid}/translation`, "PUT", { translation, base_rev }, as);
    const r1 = await json(await put("uno", (await json(await call(api(`/texts/${tid}/translation`)))).rev));
    await put("Bob's", r1.rev, BOB);
    await expectStale(await put("Alice's", r1.rev), null);
    expect((await json(await call(api(`/texts/${tid}/translation`)))).translation).toBe("Bob's");
  });

  it("summary, by both routes", async () => {
    const { tid } = await shared();
    const loaded = (await json(await call(api(`/texts/${tid}/summary`)))).rev;
    expect((await json(await call(api(`/texts/${tid}`)))).text.summary_rev).toBe(loaded);
    const bob = await json(await send(`/texts/${tid}/summary`, "PUT", { summary: "Bob's", base_rev: loaded }, BOB));
    await expectStale(await send(`/texts/${tid}/summary`, "PUT", { summary: "Alice's", base_rev: loaded }), null);
    await expectStale(await send(`/texts/${tid}`, "PUT", { summary: "Alice's", base_rev: loaded }), null);
    expect((await json(await call(api(`/texts/${tid}/summary`)))).summary).toBe("Bob's");
    const upd = await json(await send(`/texts/${tid}`, "PUT", { summary: "Alice's", base_rev: bob.rev }));
    expect(upd.text.summary).toBe("Alice's");
    expect(upd.text.summary_rev).toBe((await json(await call(api(`/texts/${tid}/summary`)))).rev);
  });

  it("a save without base_rev keeps the old behaviour; a malformed one is refused", async () => {
    const { tid } = await shared();
    const pageId = await seedPage(tid, { ocr: "first", pageNumber: 1 });
    expect((await send(`/texts/${tid}/pages/${pageId}`, "POST", { text: "no base" })).status).toBe(200);
    expect((await send(`/texts/${tid}/save`, "POST", { text: "no base" })).status).toBe(200);
    for (const base_rev of [5, "", "x".repeat(65)]) expect((await send(`/texts/${tid}/save`, "POST", { text: "y", base_rev })).status, String(base_rev)).toBe(400);
  });
});
