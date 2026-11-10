import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cailErrorEnvelope, cailErrorResponse } from "@cuny-ai-lab/cail-client/testing";
import { ALICE, JPEG, api, call, createProject, createText, json, legs, makeEnv, upload } from "./helpers";
import { gatewayEnv } from "./gateway-stub";
import { errorTypeName } from "../src/logging";
import { AppError } from "../src/errors";
import indexModule from "../src/index";

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());
const events = () => lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
const named = (name: string) => events().filter((e) => JSON.stringify(e).includes(`"${name}"`));

describe("operational logging carries no content, names, subjects or credentials", () => {
  it("through a failed OCR call, an auth rejection and an unexpected exception", async () => {
    const SECRETS = ["SECRET-PROVIDER-TEXT", "PROMPT-SECRET-WORDS", "PAGE-CONTENT-XYZ", "private-scan-name"];
    const e = await gatewayEnv({ chat: () => ({ response: cailErrorResponse(503, cailErrorEnvelope({ code: "upstream_unavailable", message: "SECRET-PROVIDER-TEXT", type: "server_error" }), { "x-should-retry": "true" }) }) });
    const pid = await createProject(ALICE, "Project PAGE-CONTENT-XYZ");
    const tid = await createText(ALICE, pid, "private-scan-name");
    const page = (await json(await upload(api(`/texts/${tid}/pages`), JPEG(), ALICE, { query: { filename: "private-scan-name.jpg" }, env: e }))).page;
    const headers = await legs(ALICE);
    lines = [];
    const res = await call(api(`/texts/${tid}/pages/${page.id}/ocr`), { method: "POST", body: { prompt: "PROMPT-SECRET-WORDS" }, env: e, as: null, headers });
    expect(res.status).toBe(503);
    await call(api("/session"), { as: null, headers: { "x-cail-identity-jwt": "garbage.token.value", "x-cail-gateway-identity-jwt": headers["x-cail-gateway-identity-jwt"]! } });
    const broken = await makeEnv({ DB: { prepare: () => { throw new TypeError("boom PAGE-CONTENT-XYZ"); } } as unknown as D1Database });
    expect((await call(api("/session"), { env: broken })).status).toBe(500);

    const task = named("model_task.completed");
    expect(task).toHaveLength(1);
    expect(JSON.stringify(task[0])).toContain("/manifold-companion/api/texts/{id}/pages/{pageId}/ocr");
    expect(JSON.stringify(task[0])).toContain("upstream_unavailable");
    expect(named("auth.rejected").map((x) => JSON.stringify(x))).toEqual([expect.stringContaining("invalid_credential")]);
    expect(JSON.stringify(named("manifold_companion.unhandled_error"))).toContain("typeerror");

    const all = lines.join("\n");
    for (const s of [...SECRETS, ALICE, headers["x-cail-identity-jwt"]!, headers["x-cail-gateway-identity-jwt"]!, pid, tid, page.id, "boom"]) expect(all, s).not.toContain(s);
    expect(all).not.toMatch(/cail-[0-9a-f]{32}/);
  });

  it("a successful task logs an ok terminal with no error type", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "fine" }) });
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid);
    const page = (await json(await upload(api(`/texts/${tid}/pages`), JPEG(), ALICE, { query: { filename: "a.jpg" }, env: e }))).page;
    lines = [];
    expect((await call(api(`/texts/${tid}/pages/${page.id}/ocr`), { method: "POST", body: {}, env: e })).status).toBe(200);
    const [event] = named("model_task.completed");
    expect(JSON.stringify(event)).toContain('"ok"');
    expect(JSON.stringify(event)).not.toContain("error.type");
  });

  it("the retention cron logs its counts as one slug", async () => {
    const pending: Promise<unknown>[] = [];
    indexModule.scheduled!({ cron: "17 6 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, await makeEnv(), { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext);
    await Promise.all(pending);
    expect(JSON.stringify(named("retention.sweep"))).toContain("w0_d0_f0_c0");
  });

  it("error_type is a class or a stable code, never a message", () => {
    expect(errorTypeName(new TypeError("Cannot read /Users/someone/secret"))).toBe("typeerror");
    expect(errorTypeName(new AppError({ code: "quota_exceeded", message: "x", status: 429 }))).toBe("quota_exceeded");
    expect(errorTypeName("a string")).toBe("string");
  });

  it("the 15-minute readiness cron logs each failing check by code, and nothing when ready", async () => {
    const run = async (env: Awaited<ReturnType<typeof makeEnv>>, cron: string) => {
      const pending: Promise<unknown>[] = [];
      indexModule.scheduled!({ cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext);
      await Promise.all(pending);
    };
    await run(await gatewayEnv({}, { CF_VERSION_METADATA: { id: "v1", tag: "t", timestamp: "now" } }), "*/15 * * * *");
    expect(named("readiness.failed")).toEqual([]);
    expect(named("readiness.checked")).toEqual([]); // the verdict is daily only
    expect(named("retention.sweep")).toEqual([]); // the sweep is daily only
    await run(await gatewayEnv({ catalog: () => new Response("<html>404</html>", { status: 404 }) }), "*/15 * * * *");
    const failed = JSON.stringify(named("readiness.failed"));
    expect(failed).toContain("gateway_catalog_unreachable");
    expect(failed).toContain("version_untagged");
    expect(failed).not.toContain("<html>");
    await run(await gatewayEnv({}, { CF_VERSION_METADATA: { id: "v1", tag: "t", timestamp: "now" } }), "17 6 * * *");
    expect(JSON.stringify(named("readiness.checked"))).toContain('"ready"');
  });
});
