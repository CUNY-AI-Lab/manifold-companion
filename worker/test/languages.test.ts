import { describe, expect, it } from "vitest";
import { ALICE, JPEG, api, call, createProject, createText, json, upload } from "./helpers";
import { chatBodies, gatewayEnv } from "./gateway-stub";

// Ancient Greek and Yiddish (legacy offered both) are accepted again, and the
// model is told the language by name, not by code.
describe("languages", () => {

  it("a text's source language can be set to Yiddish; unknown codes are still refused", async () => {
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid);
    const put = (body: unknown) => call(api(`/texts/${tid}`), { method: "PUT", body });
    expect((await json(await put({ source_language: "yi", target_language: "en" }))).text).toMatchObject({ source_language: "yi" });
    expect((await put({ source_language: "klingon" })).status).toBe(400);
  });
});
