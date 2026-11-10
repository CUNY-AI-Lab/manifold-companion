import { CAIL_GATEWAY_AUDIENCE, type IdentityVerifierConfigErrorReason } from "@cuny-ai-lab/cail-identity";
import { validateConfig, type ConfigError, type Env } from "./env";
import { gatewayClient } from "./gateway";
import { APP_AUDIENCE, loadCachedVerifierConfig } from "./identity";
import { logger } from "./logging";

export type ReadinessError =
  | ConfigError
  | "d1_unreachable"
  | "d1_schema_missing"
  | "gateway_catalog_unreachable"
  | "gateway_catalog_empty"
  | `identity_app_verifier_${IdentityVerifierConfigErrorReason}`
  | `identity_gateway_verifier_${IdentityVerifierConfigErrorReason}`;

export type ConfigurationReadiness = { ok: true } | { ok: false; errors: ReadinessError[] };

export async function checkConfigurationReadiness(env: Env): Promise<ConfigurationReadiness> {
  const staticConfig = validateConfig(env);
  const errors: ReadinessError[] = staticConfig.ok ? [] : [...staticConfig.errors];

  // The same cached loader authenticated requests use, for both legs.
  const [appVerifier, gatewayVerifier] = await Promise.all([
    loadCachedVerifierConfig(env, APP_AUDIENCE),
    loadCachedVerifierConfig(env, CAIL_GATEWAY_AUDIENCE),
  ]);
  if (!appVerifier.ok) errors.push(`identity_app_verifier_${appVerifier.reason}`);
  if (!gatewayVerifier.ok) errors.push(`identity_gateway_verifier_${gatewayVerifier.reason}`);

  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('profiles', 'projects', 'r2_cleanup')").first<{ n: number }>();
      if ((row?.n ?? 0) !== 3) errors.push("d1_schema_missing");
    } catch {
      errors.push("d1_unreachable");
    }
  }
  // The GATEWAY service binding end to end, without a credential: the public
  // catalog, through the same client and adapter every model call uses. A
  // Worker that reached the Gateway by its public URL from the same zone would
  // get the zone origin's 404 instead; this probe and test/gateway-binding.test.ts
  // are what catch that before people do.
  if (env.GATEWAY) {
    try {
      const catalog = await gatewayClient(env).getCatalogSnapshot({ signal: AbortSignal.timeout(GATEWAY_PROBE_MS) });
      if (!catalog.data.some((m) => m.status === "active" && m.capabilities.includes("text-generation"))) errors.push("gateway_catalog_empty");
    } catch {
      errors.push("gateway_catalog_unreachable");
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export const GATEWAY_PROBE_MS = 5_000;

export interface ReadinessResult {
  ok: boolean;
  service: "manifold-companion";
  configuration: "ready" | "not_ready";
  version_id: string | null;
  tag: string | null;
  /** Present only when not ready. Withheld from the anonymous HTTP probe. */
  errors?: ReadinessError[];
}

export async function readinessResult(env: Env): Promise<ReadinessResult> {
  const configuration = await checkConfigurationReadiness(env);
  const versionId = env.CF_VERSION_METADATA?.id?.trim() || null;
  const tag = env.CF_VERSION_METADATA?.tag?.trim() || null;
  return {
    ok: configuration.ok && versionId !== null && tag !== null,
    service: "manifold-companion",
    configuration: configuration.ok ? "ready" : "not_ready",
    version_id: versionId,
    tag,
    ...(configuration.ok ? {} : { errors: configuration.errors }),
  };
}

// The public verdict for Doorway's anonymous canary route
// (/manifold-companion/api/health): ok, status and version only, never the
// reasons; cached per isolate so anonymous traffic cannot multiply catalog reads.
const HEALTH_CACHE_MS = 30_000;
let health: { at: number; ok: boolean; version: string | null } | null = null;

export async function publicHealth(env: Env, now = Date.now()): Promise<{ ok: boolean; version: string | null }> {
  if (health !== null && now - health.at < HEALTH_CACHE_MS) return { ok: health.ok, version: health.version };
  const result = await readinessResult(env);
  health = { at: now, ok: result.ok, version: result.version_id };
  return { ok: result.ok, version: result.version_id };
}

/** For tests: forget the cached public verdict. */
export function resetPublicHealth(): void {
  health = null;
}

// The 15-minute cron (wrangler.jsonc). Kept here: the Worker entry module may export only handlers.
export const READINESS_CRON = "*/15 * * * *";

/** Run the readiness checks; log each failing check (codes only), and the verdict when asked. */
export async function selfCheck(env: Env, logVerdict: boolean): Promise<void> {
  const started = Date.now();
  const result = await readinessResult(env).catch(() => null);
  const errors = result === null ? ["readiness_error"] : result.ok ? [] : [...(result.errors ?? []), ...(result.version_id && result.tag ? [] : ["version_untagged"])];
  for (const code of errors) logger(env).emit("readiness.failed", { error_type: code, duration_ms: Date.now() - started });
  if (logVerdict) logger(env).emit("readiness.checked", { error_type: errors.length === 0 ? "ready" : "not_ready", duration_ms: Date.now() - started });
}
