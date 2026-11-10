// Preload for scripts/live-eval-selftest.mjs: replaces fetch to the Gateway
// origin with canned replies, so the harness's real-run path (stdin key,
// runChat under Node, parsers, files, report) runs with no network and no
// spend. Also asserts how the key travels: Bearer only, never a JWT header.
import { appendFileSync } from "node:fs";
import { quotaSnapshotBody } from "@cuny-ai-lab/cail-client/testing";

const LOG = process.env.LIVE_EVAL_SELFTEST_LOG;
const row = (id, order, recommended, capabilities, price) => ({ id, object: "model", recommended, tier: recommended ? "recommended" : "advanced", order, status: "active", modality: "text", provider: "workers-ai", upstream_model: id, pricing_known: "catalog", streaming: true, sunset: null, capabilities, context_length: 128000, registry_url: null, name: id, task: "Text Generation", pricing: { currency: "USD", unit: "million_tokens", input: price[0], output: price[1], basis: "standard" } });
const CATALOG = { object: "list", data: [row("stub-vision-think", 1, true, ["text-generation", "vision", "reasoning"], [0.3, 1.2]), row("stub-vision", 2, true, ["text-generation", "vision"], [0.1, 0.3]), row("stub-text", 3, true, ["text-generation"], [0.2, 0.4]), row("stub-math-cheap", 4, false, ["text-generation", "vision", "reasoning"], [0.05, 0.1])] };
let used = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://tools.ailab.gc.cuny.edu") return realFetch(input, init);
  const auth = request.headers.get("authorization");
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ path: url.pathname, bearer: auth?.startsWith("Bearer ") ?? false, jwtHeader: request.headers.has("x-cail-identity-jwt"), requestId: request.headers.get("x-cail-request-id") })}\n`);
  if (url.pathname === "/v1/catalog") return Response.json(CATALOG);
  if (url.pathname === "/v1/quota") {
    // Keep the snapshot internally consistent: cail-client rejects one whose percentages do not add up.
    const base = quotaSnapshotBody();
    const estimated = base.estimated_used + used;
    const usedPercent = Math.round((estimated / base.limit) * 100);
    return Response.json({ ...base, estimated_used: estimated, estimated_remaining: base.limit - estimated, used_percent: usedPercent, remaining_percent: 100 - usedPercent });
  }
  if (url.pathname !== "/v1/chat/completions") return new Response("no", { status: 404 });
  const body = await request.json();
  const text = JSON.stringify(body.messages);
  let content;
  let finish = "stop";
  if (text.includes("JSON array of TeX")) content = '["\\\\frac{-3+\\\\sqrt{41}}{8}"]';
  else if (text.includes("literary translator")) content = text.includes("to it") ? "Il seno e il coseno della funzione sono periodici con una frequenza." : "El seno y el coseno de la función son periódicos con una frecuencia.";
  else if (text.includes("literary analyst")) content = "A chapter on trigonometric identities and equations.";
  else if (text.includes("semantic HTML")) {
    const page = /data-page=\\"(\d+)\\"/.exec(text)?.[1] ?? "1";
    content = body.model === "stub-math-cheap" ? "" : `\`\`\`html\n<section data-page="${page}"><h2>Identities</h2><p style="x">\\(\\cos^2(t)+\\sin^2(t)=1\\) and \\[\\cos(\\theta)=\\frac{-3+\\sqrt{41}}{8}\\] and \\(\\frac{1}{\\)</p><table><tr><td>\\(t\\)</td></tr></table></section>\n\`\`\``;
    if (body.model === "stub-math-cheap") finish = "length";
  } else content = "## Identities\n\n$\\cos^2(t)+\\sin^2(t)=1$\n\n---\n\nSolve $2\\sin(t)=1$.";
  used += 1500;
  return Response.json({ id: "c", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 2000, completion_tokens: 600, total_tokens: 2600, completion_tokens_details: { reasoning_tokens: body.model.includes("think") ? 200 : 0 }, cail_provider: "workers-ai" } }, { headers: { "x-cail-provider": "workers-ai", "x-cail-request-id": crypto.randomUUID() } });
};
