// Operational events, through @cuny-ai-lab/cail-log ONLY (scripts/check-logging.sh
// fails CI on any other console use in src/). The tenant schema has a closed
// field list; nothing here can carry a prompt, page text, file name, subject,
// credential, provider body or exception message:
//   - error_type is a slug: an exception's CLASS, or one of this app's stable
//     error codes, never a message;
//   - route is the route TEMPLATE ({id} placeholders), never a concrete path.
import { createCailLogger, defineEventCatalog, workersStructuredSink, type CailTerminalFields } from "@cuny-ai-lab/cail-log";
import type { Env } from "./env";
import { AppError } from "./errors";

const catalog = defineEventCatalog({
  // One per model task request (each is one Gateway attempt at most).
  "model_task.completed": { source: "tenant", severity: "outcome", required: ["request_id", "route", "duration_ms", "terminal", "status"], optional: ["trace", "error_type"] },
  // An identity rejection: error_type is the auth code (authentication_required, invalid_credential, identity_unavailable).
  "auth.rejected": { source: "tenant", severity: "warn", required: ["request_id", "status", "error_type"], optional: ["trace", "http_method"] },
  // A thrown value the app did not expect: error_type is its class.
  "manifold_companion.unhandled_error": { source: "tenant", severity: "error", required: ["request_id"], optional: ["trace", "error_type", "http_method"] },
  // Daily retention sweep counts packed into one slug: w<warned>_d<deleted>_f<failed>_c<cleaned>.
  "retention.sweep": { source: "tenant", severity: "info", required: ["error_type"], optional: ["duration_ms"] },
  "retention.sweep_failed": { source: "tenant", severity: "error", required: ["error_type"], optional: ["duration_ms"] },
});

const loggers = new WeakMap<object, ReturnType<typeof build>>();
function build(env: Env) {
  const configured = env.CAIL_LOG_ENV;
  const logEnv = configured === "production" || configured === "staging" || configured === "test" ? configured : "development";
  return createCailLogger({ service: "manifold-companion", release: env.CF_VERSION_METADATA?.tag || "local", env: logEnv, sourceClass: "tenant", catalog, sink: workersStructuredSink });
}
export function logger(env: Env) {
  let l = loggers.get(env);
  if (!l) {
    l = build(env);
    loggers.set(env, l);
  }
  return l;
}

const SLUG = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** The class of a thrown value as a slug. Never the message. */
export function errorTypeName(error: unknown): string {
  if (error instanceof AppError) return SLUG.test(error.code) ? error.code : "app_error";
  const name = error instanceof Error && error.name ? error.name : typeof error;
  const slug = name.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 64);
  return SLUG.test(slug) ? slug : "error";
}

/** Terminal facts for a finished request, from its status and stable error code. */
export function terminalFor(status: number, code: string | null): CailTerminalFields {
  if (status < 400) return { outcome: "ok", reason: "completed" };
  if (code === "quota_exceeded") return { outcome: "denied", reason: "quota_blocked" };
  if (code === "client_closed_request") return { outcome: "cancelled", reason: "cancelled" };
  if (code === "model_deadline_exceeded") return { outcome: "timeout", reason: "timeout" };
  if (code === "outcome_unknown" || code === "network_error") return { outcome: "outcome_unknown", reason: "unknown" };
  if (status === 429) return { outcome: "denied", reason: "rate_limited" };
  if (status === 401 || status === 403) return { outcome: "denied", reason: "denied" };
  if (code === "model_output_empty" || code === "model_output_truncated" || code === "empty_model_response" || code === "bad_model_output" || code === "empty_ocr") return { outcome: "error", reason: "application_failure" };
  if (status < 500) return { outcome: "client_error", reason: "client_error" };
  return { outcome: "error", reason: "upstream_failure" };
}
