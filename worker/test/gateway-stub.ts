import { quotaSnapshotBody } from "@cuny-ai-lab/cail-client/testing";
import { fakeFetcher, makeEnv, type FakeFetcher } from "./helpers";
import { CATALOG } from "./catalog.fixture";
import { resetCatalogCache } from "../src/models";
import type { Env } from "../src/env";

export interface ChatReply { text?: string; finish_reason?: string; response?: Response; usage?: Record<string, number> }
export interface StubOptions {
  catalog?: () => Response;
  chat?: (body: any, request: Request) => ChatReply | Promise<ChatReply>;
  quota?: () => Response;
}

/** A stub GATEWAY service binding. Real: Hono app, CAIL identity, cail-client. Substituted: only the Gateway. */
export async function gatewayEnv(opts: StubOptions = {}, overrides: Partial<Env> = {}): Promise<Env> {
  resetCatalogCache();
  const gateway = fakeFetcher(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/catalog") return opts.catalog ? opts.catalog() : Response.json(CATALOG);
    if (path === "/v1/quota") return opts.quota ? opts.quota() : Response.json(quotaSnapshotBody());
    if (path === "/v1/chat/completions") {
      const body = (await request.clone().json()) as any;
      const reply = opts.chat ? await opts.chat(body, request) : { text: "ok" };
      if (reply.response) return reply.response;
      return Response.json({
        id: "chatcmpl-test", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply.text ?? "ok" }, finish_reason: reply.finish_reason ?? "stop" }],
        usage: reply.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }, { headers: { "x-cail-request-id": "11111111-1111-4111-8111-111111111111" } });
    }
    return new Response("unexpected path " + path, { status: 500 });
  });
  return makeEnv({ GATEWAY: gateway, ...overrides });
}

export const gatewayOf = (env: Env): FakeFetcher => env.GATEWAY as FakeFetcher;
export const chatCalls = (env: Env): Request[] => gatewayOf(env).calls.filter((r) => new URL(r.url).pathname === "/v1/chat/completions");
export async function chatBodies(env: Env): Promise<any[]> {
  return Promise.all(chatCalls(env).map((r) => r.clone().json()));
}
