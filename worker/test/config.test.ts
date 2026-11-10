/// <reference types="vite/client" />
// The deployed configuration, read as text (no file system in workerd).
import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";

// JSONC: drop // comments outside strings, then trailing commas.
const config = JSON.parse(raw.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("wrangler.jsonc as deployed", () => {
  it("points at the provisioned D1 and R2, never a placeholder", () => {
    expect(raw).not.toMatch(/REPLACE_WITH/);
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: "DB", database_name: "cail-manifold-companion", database_id: "67481a76-aaf2-4035-b261-04e37d099246", migrations_dir: "migrations" })]);
    expect(config.d1_databases[0].database_id).toMatch(UUID);
    expect(config.r2_buckets).toEqual([{ binding: "FILES", bucket_name: "cail-manifold-companion-files" }]);
  });
  it("has no public URL, binds the Gateway by service, requires the JWKS secret, and runs both crons", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes ?? config.route).toBeUndefined();
    expect(config.services).toEqual([{ binding: "GATEWAY", service: "cail-model-api" }]);
    expect(config.secrets).toEqual({ required: ["CAIL_IDENTITY_JWKS"] });
    expect(config.vars.CAIL_IDENTITY_JWKS).toBeUndefined();
    expect(config.triggers.crons).toEqual(["17 6 * * *", "*/15 * * * *"]);
    expect(config.account_id).toBe("452c33847cf5cb1e46f391fca32fd1b5");
  });
});
