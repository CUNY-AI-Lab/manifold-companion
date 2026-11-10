# AGENTS.md (worker/)

Guidance for agents working on the CAIL-stack Worker in this directory. The rest of the repository is the legacy Express/SQLite app (see the root `CLAUDE.md`); this directory replaces it on the `cail-stack` branch. Read `docs/DESIGN.md` and `docs/HANDOFF.md` first.

## Commands (run in `worker/`)

```bash
npm ci
npm run typecheck
npm test                      # Vitest inside workerd: real Hono app, real CAIL identity, D1/R2 via Miniflare
npx wrangler deploy --dry-run --outdir .wrangler/dry-run   # needs ../client/dist (build the client first)
```

Never deploy, push, call a real model, or read `.env`/secrets from here. Local commits only.

## Non-negotiables

- Every project-scoped route calls `requireRole` (`src/authz.ts`) exactly once and has a row in the matrix in `test/authz.test.ts`.
- Identity is the verified CAIL subject only. Verify both Doorway legs; forward only the Gateway leg. Config failure is `503 identity_unavailable`.
- Every mutation passes the exact-Origin check. No Referer fallback.
- Stored HTML passes `sanitizeHtml` first and is never served as a page; previews use a sandboxed `srcdoc` iframe without `allow-same-origin`.
- No provider keys, no app-side token ledger, no hidden retries, no bulk unattended model calls, no user lookup by email or name.
- Never log prompts, files, subjects, tokens or exception messages.
- Large text and files go to R2 (`src/r2-keys.ts`, server-generated ids only); D1 holds pointers. D1 rows must stay well under 2 MB.
- Never edit an applied migration; add a new one and update `test/schema.snapshot.json` deliberately.
- Model lists come from the Gateway catalog filtered by capability. Reasoning models need output headroom; send `enable_thinking`/`reasoning_effort` only to reasoning models.
- Use `@cuny-ai-lab/cail-identity/testing` and `@cuny-ai-lab/cail-client/testing` in tests; substitute only the Gateway binding.
