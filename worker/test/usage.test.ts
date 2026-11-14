import { describe, expect, it } from "vitest";
import { ALICE, BOB, JPEG, addMember, api, call, createProject, createText, json, upload } from "./helpers";
import { canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";

const ZED = canonicalTestSubject("zed");

describe("what uses my storage, and how full a project is", () => {
  it("per owned project, the bytes the counter is recounted from; never another person's projects", async () => {
    const big = await createProject(ZED, "Big");
    const small = await createProject(ZED, "Small");
    await createProject(BOB, "Not mine");
    const shared = await createProject(BOB, "Shared with me");
    await addMember(BOB, shared, ZED, "editor");
    const t1 = await createText(ZED, big);
    const t2 = await createText(ZED, small);
    expect((await upload(api(`/texts/${t1}/pages`), JPEG(4000), ZED, { query: { filename: "a.jpg" } })).status).toBe(201);
    expect((await upload(api(`/texts/${t2}/pages`), JPEG(1000), ZED, { query: { filename: "b.jpg" } })).status).toBe(201);
    const r = await json(await call(api("/usage/storage"), { as: ZED }));
    expect(r.projects.map((p: any) => p.name)).toEqual(["Big", "Small"]);
    expect(r.projects[0].bytes).toBeGreaterThan(r.projects[1].bytes);
    expect(r.projects.reduce((n: number, p: any) => n + p.bytes, 0)).toBe(r.used_bytes);
    expect(r.quota_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/subject|cail-/);
  });

  it("project list and project carry text and page counts, so the page can check a PDF fits before rasterising it", async () => {
    const pid = await createProject(ALICE, "Counts");
    const t = await createText(ALICE, pid);
    await createText(ALICE, pid, "Second");
    await upload(api(`/texts/${t}/pages`), JPEG(500), ALICE, { query: { filename: "a.jpg" } });
    await upload(api(`/texts/${t}/pages`), JPEG(500), ALICE, { query: { filename: "b.jpg" } });
    const listed = (await json(await call(api("/projects"), { as: ALICE }))).projects.find((p: any) => p.id === pid);
    expect(listed).toMatchObject({ text_count: 2, page_count: 2 });
    expect((await json(await call(api(`/projects/${pid}`), { as: ALICE }))).project).toMatchObject({ text_count: 2, page_count: 2 });
  });
});
