// The one place this Worker talks to the CAIL Gateway: through the GATEWAY
// service binding, with @cuny-ai-lab/cail-client, forwarding ONLY the verified
// Gateway leg. One attempt per call, no hidden retries, a fresh request id for
// every outbound call, cancellation and an explicit deadline on each.
import { CailError, createCailClient, type CailClient } from "@cuny-ai-lab/cail-client";
import { correlationFromHeaders, outboundCorrelationHeaders, type CailCorrelation } from "@cuny-ai-lab/cail-log";
import type { Env } from "./env";
import { AppError, E } from "./errors";
import { APP_SLUG, type Principal } from "./identity";
import { reasoningPolicy, type ModelOption } from "./models";

export const DEADLINES_MS = { ocr: 90_000, html_page: 120_000, html_math: 150_000, text: 90_000, translate: 120_000 } as const;
export type DeadlineKey = keyof typeof DEADLINES_MS;

/** Fresh correlation for one outbound call; only the inbound trace context (not the request id) is carried over. */
export function freshCorrelation(inbound?: Request): CailCorrelation {
  const headers = new Headers();
  for (const name of ["traceparent", "tracestate"]) {
    const v = inbound?.headers.get(name);
    if (v) headers.set(name, v);
  }
  return correlationFromHeaders({ headers });
}

export function gatewayClient(env: Env, correlation?: CailCorrelation): CailClient {
  const binding = env.GATEWAY;
  const transport: typeof fetch = (input, init) => {
    if (!binding) throw E.unavailable("The model service is not configured.", "gateway_unavailable");
    return binding.fetch(input, init);
  };
  // getQuota/getCatalog take no correlation option in cail-client; the adapter carries it for them too.
  const fetchImpl: typeof fetch = (input, init) => {
    if (!correlation) return transport(input, init);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(outboundCorrelationHeaders(correlation))) headers.set(name, value);
    return transport(input, { ...init, headers });
  };
  return createCailClient({ app: APP_SLUG, baseUrl: env.CAIL_API_BASE ?? "https://tools.ailab.gc.cuny.edu", fetchImpl });
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Map anything thrown by the client into the app's safe envelope, passing through the Gateway's own safe message, x-should-retry and Retry-After. */
export function gatewayError(error: unknown, deadline: AbortSignal | undefined, request: AbortSignal | undefined): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof CailError) {
    // status 0 is a transport failure inside cail-client (network_error): the call may or may
    // not have reached the provider, so it is an ambiguous outcome and never invites a retry.
    const transport = error.status < 400 || error.status > 599;
    const status = transport ? 502 : error.status;
    const flag = error.extras.should_retry;
    const retryable = error.code === "quota_exceeded" || transport ? false : typeof flag === "boolean" ? flag : RETRYABLE.has(status);
    const headers: Record<string, string> = {};
    if (typeof error.extras.retry_after === "string" && /^\d{1,8}$/.test(error.extras.retry_after.trim())) headers["retry-after"] = error.extras.retry_after.trim();
    else if (typeof error.extras.retry_after_seconds === "number" && Number.isInteger(error.extras.retry_after_seconds) && error.extras.retry_after_seconds >= 0) headers["retry-after"] = String(error.extras.retry_after_seconds);
    return new AppError({ code: error.code, message: error.message, status, retryable, headers, ...(error.extras.request_id ? { gatewayRequestId: String(error.extras.request_id) } : {}) });
  }
  if (request?.aborted) return new AppError({ code: "client_closed_request", message: "The request was cancelled.", status: 499 });
  if (deadline?.aborted) {
    return new AppError({ code: "model_deadline_exceeded", message: "The model did not answer in time. The call may still have been billed; try a different model.", status: 504 });
  }
  return new AppError({ code: "outcome_unknown", message: "The model service did not confirm whether the request completed.", status: 502 });
}

export function deadlineSignal(env: Env, key: DeadlineKey, request: AbortSignal): { signal: AbortSignal; deadline: AbortSignal } {
  const cap = Number(env.MODEL_DEADLINE_MS);
  const ms = Number.isInteger(cap) && cap > 0 ? Math.min(cap, DEADLINES_MS[key]) : DEADLINES_MS[key];
  const deadline = AbortSignal.timeout(ms);
  return { signal: AbortSignal.any([request, deadline]), deadline };
}

export interface ChatResult {
  text: string;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  gatewayRequestId: string | null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  return "";
}

/** Visible text with inline reasoning blocks removed (some models put them in the content). */
const stripVisibleReasoning = (text: string): string => text.replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, "");

export interface ChatTask {
  model: ModelOption;
  messages: unknown[];
  /** Tokens the task needs for its visible answer; reasoning headroom is added on top. */
  maxTokens: number;
  temperature: number;
  /** True for tasks that need the model to think (math); false switches thinking off where honored. */
  wantsThinking: boolean;
  deadline: DeadlineKey;
}

/**
 * One chat completion, one attempt (cail-client never retries and refuses
 * redirects). Cancellation: the inbound request's signal (enable_request_signal)
 * combined with a per-task deadline. A fresh request id goes on the outbound
 * call; only the inbound trace context is carried. A reply that stopped on its
 * token limit is never treated as success (model_output_empty / _truncated).
 */
export async function runChat(env: Env, principal: Principal, request: Request, task: ChatTask): Promise<ChatResult> {
  const { signal, deadline } = deadlineSignal(env, task.deadline, request.signal);
  const policy = reasoningPolicy(task.model, task.wantsThinking);
  let response: Response;
  try {
    response = await gatewayClient(env).chatCompletions(
      { model: task.model.id, stream: false, max_tokens: task.maxTokens + policy.headroom, temperature: task.temperature, ...policy.extraBody, messages: task.messages as never },
      principal.credential,
      { signal, correlation: freshCorrelation(request) },
    );
  } catch (error) {
    throw gatewayError(error, deadline, request.signal);
  }
  const gatewayRequestId = response.headers.get("x-cail-request-id") ?? response.headers.get("x-request-id");
  let body: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: ChatResult["usage"] };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    // Cancelled or past the deadline while the body was still arriving.
    if (signal.aborted) throw gatewayError(error, deadline, request.signal);
    throw new AppError({ code: "bad_gateway_response", message: "The model service returned an unreadable reply.", status: 502, ...(gatewayRequestId ? { gatewayRequestId } : {}) });
  }
  const choice = body.choices?.[0];
  const text = extractText(choice?.message?.content);
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  // finish_reason "length" is never success. Two distinct codes, because the remedy differs:
  //  - model_output_empty: a reasoning model spent the whole budget thinking and wrote nothing;
  //  - model_output_truncated: the answer stopped mid-way, so it is incomplete and is discarded.
  if (finishReason === "length") {
    const empty = stripVisibleReasoning(text).trim() === "";
    throw new AppError({
      code: empty ? "model_output_empty" : "model_output_truncated",
      message: empty
        ? "The model used its whole output budget before writing anything (reasoning models spend tokens thinking). Try another model."
        : "The model reached its output limit mid-answer, so the result is incomplete and was not used. Try another model or a smaller page.",
      status: 422,
      ...(gatewayRequestId ? { gatewayRequestId } : {}),
    });
  }
  if (text.trim() === "") {
    throw new AppError({ code: "empty_model_response", message: "The model returned no text.", status: 502, ...(gatewayRequestId ? { gatewayRequestId } : {}) });
  }
  return { text, finishReason, usage: body.usage ?? null, gatewayRequestId };
}
