# Handoff: phase 1 (foundation) to phase 2+

Read `DESIGN.md` first (architecture, data model, route map, model tasks, email, Doorway changes). This file says what is done, what is stubbed, what to build next, and what is still unknown.

Run everything from `worker/`: `npm ci`, `npm run typecheck`, `npm test`, `npx wrangler deploy --dry-run --outdir .wrangler/dry-run`. The dry run needs `client/dist` (`npm ci --workspace client --include-workspace-root --ignore-scripts && npm run build --workspace client` at the repo root). `.npmrc` pins the `@cuny-ai-lab` registry to npmjs and sets `legacy-peer-deps` (npm's resolver crashes on the vitest plugin's optional peer set without it).

## 1. Done (tested)

- Worker skeleton: Hono app, typed env + config validation, identity (both legs, config-first 503), CSRF, request ids, error envelope, bounded bodies, security headers/CSP, canonical-origin 404, SPA serving under `/manifold-companion`, readiness (`/health/live`, `/health/ready`, `ManifoldCompanionReadiness` RPC), `scheduled()`.
- D1 schema (`0001_init.sql`, `0002_search.sql`), FK cascade fix, FTS5 table + triggers, storage counter helpers, R2 key layout and prefix deletion.
- `requireRole` and routes: `GET /session`, `PUT /profile`, `DELETE /me/data`, projects CRUD, members list/remove/leave, invites create/list/revoke/redeem.
- Retention sweep (warn then delete) and its cron trigger.
- HTML sanitizer module + 100-payload XSS corpus + fuzz, verified under workerd; `serveBody` for stored files.
- 201 tests, CI workflow `.github/workflows/worker-ci.yml` (typecheck, test, dry-run, no deploy job).

## 2. Stubbed / not done (do not assume it exists)

| Item | State |
|---|---|
| Sanitizer | Module exists and is tested, **not wired to any route** (no text routes yet). The write path for `html` must call `sanitizeHtml` before R2 `put` and before indexing. |
| FTS | Table and cleanup triggers exist; **nothing writes `text_fts` rows** except tests. Writer (`upsertTextIndex(text_id, project_id, title, htmlToPlainText(...))`, capped 500 KB) and `GET /search` are WP1. |
| Quota | `reserveStorage` / `releaseStorage` / `projectStorageBytes` exist and are tested; no upload route calls them yet. `MAX_FILE_BYTES` and `MAX_PROJECT_PAGES` are config only. |
| `GATEWAY` binding | Declared in `wrangler.jsonc` and required by readiness; **no Gateway call is made anywhere**. No `cail-client` code is written. |
| Logging | `console.error` of the error class only. `@cuny-ai-lab/cail-log` is installed (correlation only); no structured events yet. |
| `touchProject` | Only `PUT /projects/:id` bumps `last_edited_at`. Every content write must too (and clear `retention_warned_at`). |
| Member role change | `PUT /projects/:id/members/:subject` not built (remove + re-invite works). |
| Client | **Untouched.** It still calls `/api/auth/*`, expects the legacy shapes, uses `EventSource` for OCR, and `BASE_URL` already equals `/manifold-companion/`. |
| Email | Design only (DESIGN section 9). Nothing implemented. |
| Real infra | D1 id in `wrangler.jsonc` is `REPLACE_WITH_D1_DATABASE_ID`; D1 database, R2 bucket, `CAIL_IDENTITY_JWKS` secret, R2 lifecycle rule for `p/*/export/` (1 day) and multipart-abort rule do not exist. |
| Doorway mount | Not made (DESIGN section 12 lists every file). |
| Deploy | None. Never run `wrangler deploy` without `--dry-run` from this branch until Doorway is ready (receiver-first). |

## 3. Next work packages

Order: WP0 can run in parallel with everything; WP1 before WP2-WP6; WP3 and WP4 need WP2.

### WP0: infra and mount (owner + Stephen, not code-heavy)
- Create D1 + R2 bucket; paste D1 id; `wrangler d1 migrations apply DB --remote` on a **scratch** database first.
- **Acceptance:** migrations apply remotely (this settles FTS5-on-D1, open question 1); `ManifoldCompanionReadiness.getReadiness()` returns `ok: true` after setting `CAIL_IDENTITY_JWKS` (Doorway's public JWKS) via `wrangler secret put`; R2 lifecycle rules created and read back; Doorway mount PR (DESIGN section 12) opened as **draft** in `cail-tools-admission` with the mutation tests written first; release probes pass; `workers.dev` 404s.

### WP1: texts, pages, versions, metadata, settings, search (no models)
Routes in the DESIGN section 11 "Texts, pages, files" table that do not touch files or models: create/get/put/delete text, reorder, page save/delete/reorder, `result`, `html` get/put, `save`, metadata, settings, versions list/get/revert, split/merge/bulk-delete/bulk-status, `GET /search`.
- Each route calls `requireRole` once; **add each to `ROUTES` in `test/authz.test.ts`** (the coverage test fails otherwise; extend its filter to `/texts/:id`).
- `html` writes: `sanitizeHtml` -> R2 `htmlKey` -> `text_versions` row (R2 `versionKey`, sha256, bytes) -> `touchProject` -> FTS upsert of `htmlToPlainText`. Prune to 50 versions per text+type, deleting the R2 bodies and releasing bytes.
- Page `ocr_text` cap 256 KB, `summary` cap 20 KB, FTS body cap 500 KB (D1 2 MB row limit; local Miniflare does not enforce it, so write explicit tests of your caps).
- Keep the `__compiled__` sentinel? Recommended: replace with a real `texts.compiled_key` pointer (R2) so the sentinel page row disappears. Decide and document.
- **Acceptance:** authz matrix covers every new route (owner/editor/viewer/stranger); viewers cannot write; search returns only the caller's projects (test with two people sharing a term); deleting a text removes its R2 objects, bytes and FTS row; bulk operations chunk D1 binds <= 90; an XSS payload saved through `PUT html` is inert on read.

### WP2: uploads with enforced quota
`POST /texts/:id/pages` (images), `PUT /texts/:id/source-pdf`, image/PDF GET via `serveBody`.
- Order: validate role -> check page cap (`pages` count vs `MAX_PROJECT_PAGES`) -> check declared and streamed size vs `MAX_FILE_BYTES` (Doorway strips `content-length`; use `readBoundedBytes`) -> **magic-byte check** (JPEG/PNG/WebP/PDF; reject everything else) -> `reserveStorage(owner)` -> `R2.put` -> insert row; any failure after reserve calls `releaseStorage`.
- Charge the **project owner**, not the uploader (DESIGN section 6).
- Never use client file names in keys. Store the cleaned name in `pages.filename` only.
- **Acceptance:** upload over the cap, over quota, wrong type (valid content-type, wrong bytes), and over page cap are each refused with a stable code and leave no R2 object and no counter change; concurrent uploads cannot exceed quota; a viewer cannot upload; owner `storage_bytes` equals `projectStorageBytes` after a mix of uploads and deletes (add a reconcile test); responses carry the right content type + `nosniff`.

### WP3: Gateway client; OCR, summary, translation, models, quota
- `src/gateway.ts` modelled on LanGames `gateway.ts` (client with `app: "manifold-companion"`, `fetchImpl` = `env.GATEWAY.fetch`, correlation headers, `appErrorFrom`), `src/models.ts` (catalog filter by capability, 60 s cache, **fail closed** when the catalog is down for vision tasks rather than falling back to a hard-coded model; LanGames' fallback is a text-only convenience), `GET /api/models`, `GET /api/quota` (proxy Gateway `/quota`, microdollars), `POST /texts/:id/pages/:pageId/ocr`, summary and translation routes.
- Per-page, person-initiated only. Output headroom +4000 tokens for catalog `reasoning` models; `enable_thinking:false`/`reasoning_effort:"low"` only for reasoning models; treat empty + `finish_reason: length` as `model_output_truncated`. One attempt, no retries, forward `x-should-retry`, pass `c.req.raw.signal`.
- Sanitize/clean model output before storing; cap stored OCR at 256 KB; log nothing about prompts or output.
- **Acceptance:** tests use the real Hono app, real identity verification, real `cail-client` and `@cuny-ai-lab/cail-client/testing` helpers with only the Gateway **binding** substituted (follow `LanGames/cail/test/app.test.ts`): the Gateway sees the **Gateway leg only** (assert the `x-cail-identity-jwt` value equals the leg, and the app assertion is absent); request body contains an `image_url` data URI and no file/PDF part; a model not in the catalog is `model_not_allowed` with no Gateway call; a text-only model is refused for OCR; quota exhaustion maps to non-retryable `quota_exceeded`; no loop exists that processes more than one page per request; reasoning model gets headroom, non-reasoning model gets no `enable_thinking`. A **live** smoke with a personal key against the real Gateway is a manual gate (see LanGames' September 20 test) before release.

### WP4: PDF to HTML, including math
- Client-side first: pdf.js rendering to canvas, text-layer hint, figure extraction (replacing `pdftohtml`), per-page "math/tables" toggle, `pdfBedrockPipeline.js` rewritten to call `POST /texts/:id/pages/:n/html` one page at a time with Cancel.
- Worker: page HTML route (math model per DESIGN section 8), `html/cleanup`, `formula-repair` (text model on unresolved formulas), figure upload (WP2 rules), `PUT html` through the sanitizer (WP1).
- **Measure before choosing the default math model:** build a 5-10 page math PDF fixture (formulas, tables, multi-column), run each candidate catalog model (vision, and vision+reasoning) with a real key, compare, record cost/time/quality in `worker/docs/math-model-comparison.md`.
- **Acceptance:** math page request uses `math_model`; non-math uses `model`; both validated against the live catalog; MathML and TeX delimiters survive sanitize -> store -> export; hostile model output (`<script>`, `javascript:` links, `onerror`) is inert after storage; preview renders in `<iframe sandbox srcdoc>` **without** `allow-same-origin` (client test).

### WP5: export
Port `export.js` ZIP structure exactly (Manifold ingestion depends on it): `fflate` in the Worker (streaming `Zip`, R2 bodies as entries) or client-side; `temml` TeX->MathML at export; `export_settings` routes.
- **Acceptance:** golden test comparing the ZIP listing and a representative HTML file against a fixture produced by the legacy exporter from the same input; 300-page project exports under the Worker memory/CPU limits (test with a synthetic project; if it does not fit, fall back to client-side assembly); export requires viewer; ZIP served with `application/zip`, `attachment`, `nosniff`; temp export objects expire (R2 lifecycle).

### WP6: annotations, notifications, mentions
Per DESIGN section 11. Mentions restricted to current members; notification fan-out is subject-scoped; retention warnings already create `retention_warning` notifications (client must render that type and link).
- **Acceptance:** authz matrix rows; a viewer cannot edit others' annotations; deleting a profile removes their annotations and replies; mention of a non-member is rejected; no email address appears anywhere.

### WP7: client adaptation
- Remove login/register/forgot/reset/admin pages and `AuthContext` password logic; `AuthContext` calls `GET /api/session`.
- **Session-expiry navigation** (Browser Sign-In contract): in `client/src/api/client.js`, on a `401` whose `error.code` is `authentication_required` **or** `session_invalid`, do a full-page `window.location.assign("/launch/manifold-companion")` (fixed path, never derived from the response; no retry; no fetch of the login URL; no following redirects in `fetch`). Media Tools and Agent Studio each missed one of the two codes; handle both and unit-test both. A `401 invalid_credential` is a deployment fault: show an error, do not navigate.
- Replace `EventSource` OCR with the client-driven per-page loop; replace sharp-dependent upload assumptions with canvas resize + HEIC handling; sandboxed `srcdoc` previews for all stored HTML (no `allow-same-origin`, no `allow-scripts`); remove DOMPurify-as-only-defence assumptions (server sanitizes too); invite redemption page at `/invite` reading `location.hash` (`#t=...`) then `history.replaceState` to clear it; dashboard retention banner from `project.retention.warning`; model pickers from `/api/models`; Gateway quota display; "Delete my data" in Settings (two-step confirm); remove token-usage bars and mailto quota requests.
- The CSP is `script-src 'self'`: no inline scripts, no CDN scripts (pdf.js worker must be bundled and served same-origin; KaTeX CSS/fonts bundled). Test the built bundle with the real CSP in a browser (Playwright) before release.
- **Acceptance:** Playwright against `wrangler dev` with the test issuer's JWKS: sign-in state, create project, upload page (stubbed Gateway), OCR one page, invite flow between two test subjects, expiry navigation for both 401 codes, no CSP violations in console.

### WP8: logging
`@cuny-ai-lab/cail-log` schema-approved events only (unhandled error class, auth outcome codes, model-call outcome and duration, retention sweep counts). Never log prompts, page content, filenames, subjects or arbitrary exception text. **Acceptance:** a test captures log output through a full OCR failure and asserts none of the request content, subject or JWT appears.

### WP9: retention in production
Cron is configured and the sweep is tested. Remaining: verify in production that the scheduled handler fires (Cloudflare dashboard cron history), add alerting on `failed > 0`, decide the email path (DESIGN section 9), and decide the client's handling of a deleted project (404 -> friendly message).

### WP10: release
Receiver-first: deploy Worker -> readiness readback -> Doorway mount PR out of draft -> CUNY Login journey, one real OCR page, quota movement, expiry navigation, `workers.dev` 404. Retire the legacy host only after the owner agrees (fresh start: no migration).

## 4. Rules for whoever continues

- Do not add a route without `requireRole` and an authz-matrix row. Do not read `subject` from request bodies, params you did not validate, or headers other than through `authenticate`.
- Do not add a hidden retry, a server-side bulk model loop, a provider key, a parallel ledger, or a way to look up a person by email or name.
- Do not serve user HTML as a page; do not store HTML that did not pass `sanitizeHtml`.
- Do not log prompts, files, subjects, tokens or exception messages.
- Never edit an applied migration; add `0003_*.sql`. `test/migrations.test.ts` compares to `test/schema.snapshot.json`; regenerate it by emptying the file to `{}`, running that test (it prints the new snapshot), reviewing the diff by hand, and committing.
- Tests share a database per file; `test/setup.ts` empties it before each test through the real cascade.
- Legacy code on `main` keeps running; do not delete `server/` or change root `package.json` workspaces until cutover.

## 5. Open questions

1. **FTS5 on remote D1.** Works in Miniflare; not confirmed in D1 docs. Test on a scratch D1 (WP0). Fallback in DESIGN section 3.
2. **Real D1 2 MB row limit is not enforced locally.** Enforce caps in code (WP1) and consider a staging test with an oversized insert.
3. **Gateway `tool` attribution.** Doorway's `GATEWAY_TOOLS` and the claims-contract enum list four tools. Adding `manifold-companion` touches Doorway, the shared contract and possibly the Gateway; without it the Gateway reports calls as unattributed (still billed to the person). Ask Stephen Zweibel; check how LanGames' PR #234 handled it.
4. **Does a `gatewayIdentity` Doorway route get Admission membership enforcement automatically?** The Integration Contract says membership-protected forwards check the resolver; confirm in `doorway.ts` for authenticated JWT routes (I did not trace it end to end).
5. **Doorway request-body ceiling over the service binding.** Media Tools uses 6 MB JSON bodies; I found only a class-claim body limit in the files I read. Confirm the limit for mounted tools before committing to 4 MB page images and 10 MB uploads (multi-part and raw PUT).
6. **Viewer commenting.** Legacy let viewers comment (annotations needed `viewer`? I did not re-verify). Product decision: can viewers annotate? DESIGN assumes editor+ write.
7. **Email (DESIGN section 9).** Owner/Stephen: is in-app-only acceptable for launch? The retention warning is only seen by people who sign in. Request `AdmissionToolNotice` from Admission now (lead time).
8. **Math model default** and whether any catalog model has both `vision` and `reasoning` today. Measure (WP4).
9. **Server-side vs client-side ZIP.** Depends on Worker memory with real projects (WP5).
10. **Quota accounting charged to owner.** Is it acceptable that an editor's uploads consume the owner's 500 MB? Alternative is charging the uploader; DESIGN explains why not. Owner to confirm.
11. **Version-count pruning and storage.** 50 versions/text/type of large HTML can approach the quota; consider snapshot dedupe by `sha256` or a lower cap.
12. **`workerd` observability.** `invocation_logs:false` is copied from the references; confirm what Workers Logs will contain for this Worker.
13. **Repository policy conflict.** Root `CLAUDE.md` says never to add AI attribution to commits; the task brief required a `Co-Authored-By` trailer, which was used on this branch's commits. Rewrite the trailer if the repo rule should win.
14. **Retention ownership edge:** projects with a non-owner who is actively editing but the owner never returns: editor edits bump `last_edited_at` (WP1 `touchProject`), so the project lives on; the owner never gets email. Confirm that is the intent.
