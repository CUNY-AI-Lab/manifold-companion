import { describe, expect, it } from "vitest";
import { ALICE, JPEG, api, call, createProject, createText, json, upload } from "./helpers";
import { chatBodies, gatewayEnv } from "./gateway-stub";

// Ancient Greek and Yiddish (legacy offered both) are accepted again, and the
// model is told the language by name, not by code.
describe("languages", () => {
  it("translate-chunk accepts grc and yi and names the languages in the prompt", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "Sing, goddess." }) });
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid);
    await upload(api(`/texts/${tid}/pages`), JPEG(256), ALICE, { query: { filename: "p1.jpg" }, env: e });
    const ok = await call(api(`/texts/${tid}/translate-chunk`), { method: "POST", body: { text: "Μῆνιν ἄειδε θεά", source_language: "grc", target_language: "yi" }, env: e });
    expect(ok.status).toBe(200);
    const [sent] = await chatBodies(e);
    expect(sent.messages[0].content).toContain("from Ancient Greek to Yiddish");
    const auto = await call(api(`/texts/${tid}/translate-chunk`), { method: "POST", body: { text: "Hola.", source_language: "auto-detect", target_language: "en" }, env: e });
    expect(auto.status).toBe(200);
    const [, second] = await chatBodies(e);
    expect(second.messages[0].content).toContain("to English");
    expect(second.messages[0].content).not.toContain("auto-detect");
  });

  it("a text's source language can be set to Yiddish; unknown codes are still refused", async () => {
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid);
    const put = (body: unknown) => call(api(`/texts/${tid}`), { method: "PUT", body });
    expect((await json(await put({ source_language: "yi", target_language: "en" }))).text).toMatchObject({ source_language: "yi" });
    expect((await put({ source_language: "klingon" })).status).toBe(400);
  });
});
