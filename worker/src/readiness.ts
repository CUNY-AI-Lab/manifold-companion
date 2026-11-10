import { CAIL_GATEWAY_AUDIENCE, type IdentityVerifierConfigErrorReason } from "@cuny-ai-lab/cail-identity";
import { validateConfig, type ConfigError, type Env } from "./env";
import { APP_AUDIENCE, loadCachedVerifierConfig } from "./identity";

export type ReadinessError =
  | ConfigError
  | "d1_unreachable"
  | "d1_schema_missing"
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
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

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
