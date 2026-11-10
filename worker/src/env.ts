export interface Env {
  ASSETS: Fetcher;
  /** Gateway service binding (cail-model-api). Unused in phase 1; readiness requires it. */
  GATEWAY?: Fetcher;
  DB: D1Database;
  FILES: R2Bucket;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  /** Worker secret: Doorway's public JWKS. */
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  CAIL_CANONICAL_ORIGIN?: string;
  CAIL_API_BASE?: string;
  CAIL_LOG_ENV?: string;
  /** Per-person storage quota in bytes (default 500 MB). */
  STORAGE_QUOTA_BYTES?: string;
  /** Per-uploaded-file cap in bytes (default 10 MB). */
  MAX_FILE_BYTES?: string;
  /** Per-source-PDF cap in bytes (default 25 MB). */
  MAX_PDF_BYTES?: string;
  /** Per-project page cap (default 300). */
  MAX_PROJECT_PAGES?: string;
  /** Days after last edit before a project is deleted (default 180). */
  RETENTION_DAYS?: string;
  /** Days before deletion at which the in-app warning starts (default 30). */
  RETENTION_WARN_DAYS?: string;
}

/** The API and pages are mounted at this literal prefix by Doorway. */
export const BASE_PATH = "/manifold-companion";
const DEFAULT_ORIGIN = "https://tools.ailab.gc.cuny.edu";

export function canonicalOrigin(env: Env): string {
  return env.CAIL_CANONICAL_ORIGIN ?? DEFAULT_ORIGIN;
}

export interface Limits {
  storageQuotaBytes: number;
  maxFileBytes: number;
  maxPdfBytes: number;
  maxFiguresPerText: number;
  maxProjectPages: number;
  retentionDays: number;
  retentionWarnDays: number;
  /** Largest JSON body any route accepts. */
  maxJsonBytes: number;
  maxProjectsPerPerson: number;
  maxActiveInvitesPerProject: number;
  maxInviteTtlDays: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function limits(env: Env): Limits {
  return {
    storageQuotaBytes: positiveInt(env.STORAGE_QUOTA_BYTES, 500 * 1024 * 1024),
    maxFileBytes: positiveInt(env.MAX_FILE_BYTES, 10 * 1024 * 1024),
    maxPdfBytes: positiveInt(env.MAX_PDF_BYTES, 25 * 1024 * 1024),
    maxFiguresPerText: 200,
    maxProjectPages: positiveInt(env.MAX_PROJECT_PAGES, 300),
    retentionDays: positiveInt(env.RETENTION_DAYS, 180),
    retentionWarnDays: positiveInt(env.RETENTION_WARN_DAYS, 30),
    maxJsonBytes: 2 * 1024 * 1024,
    maxProjectsPerPerson: 100,
    maxActiveInvitesPerProject: 20,
    maxInviteTtlDays: 30,
  };
}

export type ConfigError =
  | "identity_jwks_missing"
  | "identity_issuer_missing"
  | "gateway_binding_missing"
  | "db_binding_missing"
  | "files_binding_missing"
  | "assets_binding_missing"
  | "canonical_origin_invalid"
  | "api_base_invalid"
  | "limit_invalid";

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && !value.includes("?") && !value.includes("#");
  } catch {
    return false;
  }
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.origin === value;
  } catch {
    return false;
  }
}

// Declared non-optional, but a config mistake really does leave bindings undefined.
const missing = (v: unknown): boolean => v === undefined || v === null;

export function validateConfig(env: Env): { ok: true } | { ok: false; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  if (!env.CAIL_IDENTITY_JWKS?.trim()) errors.push("identity_jwks_missing");
  if (!env.CAIL_IDENTITY_ISSUER?.trim()) errors.push("identity_issuer_missing");
  if (missing(env.GATEWAY)) errors.push("gateway_binding_missing");
  if (missing(env.DB)) errors.push("db_binding_missing");
  if (missing(env.FILES)) errors.push("files_binding_missing");
  if (missing(env.ASSETS)) errors.push("assets_binding_missing");
  if (env.CAIL_CANONICAL_ORIGIN !== undefined && !validOrigin(env.CAIL_CANONICAL_ORIGIN)) errors.push("canonical_origin_invalid");
  if (env.CAIL_API_BASE !== undefined && !validHttpsUrl(env.CAIL_API_BASE)) errors.push("api_base_invalid");
  for (const v of [env.STORAGE_QUOTA_BYTES, env.MAX_FILE_BYTES, env.MAX_PDF_BYTES, env.MAX_PROJECT_PAGES, env.RETENTION_DAYS, env.RETENTION_WARN_DAYS]) {
    if (v !== undefined && v !== "" && positiveInt(v, -1) === -1) {
      errors.push("limit_invalid");
      break;
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
