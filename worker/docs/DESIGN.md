# Manifold Companion on the CAIL stack: design (phase 1)

Status: foundation built and tested; features are ported in later phases (see `HANDOFF.md`).
Branch `cail-stack`. The legacy Express/SQLite app on `main` is untouched and keeps running on its old host.

## 1. What this is

A Cloudflare Worker (Hono, TypeScript) in `worker/`, mounted by CAIL Doorway at
`https://tools.ailab.gc.cuny.edu/manifold-companion/`, audience `cail:manifold-companion`, **person-funded**: Doorway sends
an app assertion plus a same-subject `cail:gateway` leg; model spend lands on the signed-in person's own Gateway budget.
It reuses the React client (`client/`, built to `client/dist`, Vite `base` is already `/manifold-companion/`).

Fresh start: no legacy users or projects are migrated. There are no passwords, registration, approval, reset or local
sessions. Identity is the opaque CAIL subject; Admission membership (checked by Doorway) replaces approval.

```
browser ──► Doorway (CUNY Login, Admission membership, CSRF-independent)
              │  service binding MANIFOLD_COMPANION, original path /manifold-companion/...
              │  headers: x-cail-identity-jwt (aud cail:manifold-companion)
              │           x-cail-gateway-identity-jwt (aud cail:gateway, same subject)
              ▼
        cail-manifold-companion (this Worker)
          ├─ canonical-origin gate ─ request id ─ security headers
          ├─ /manifold-companion/api/*  CSRF(Origin) ─ identity(both legs) ─ profile upsert ─ routes
          ├─ /manifold-companion/*      static SPA from ASSETS (index.html fallback for client routes)
          ├─ /health/live, /health/ready, ManifoldCompanionReadiness RPC (Doorway release probe)
          ├─ scheduled: daily retention sweep
          ├─ D1  (DB)     relational data + FTS5
          ├─ R2  (FILES)  uploads, large text, version bodies
          └─ GATEWAY service binding ► cail-model-api   (declared now; first used in the Gateway-client phase)
```

## 2. Files (as built)

| File | Role |
|---|---|
| `src/env.ts` | `Env` type, config validation, limits (quota, per-file, page cap, retention), `BASE_PATH` |
| `src/identity.ts` | pinned verifier config (cached, failures never cached) then both legs; forwards only the Gateway leg |
| `src/csrf.ts` | exact-Origin check; absent Origin or Referer-only is rejected |
| `src/errors.ts`, `src/body.ts` | stable error envelope; bounded streaming body reader (Doorway strips `content-length`) |
| `src/security.ts` | CSP, `nosniff`, referrer/permissions/HSTS, cache policy |
| `src/app.ts` | middleware order, route mounting, SPA fallback, `onError` |
| `src/authz.ts` | `requireRole(db, subject, projectId, minRole)`: the only project authorization check |
| `src/storage.ts` | R2 prefix sweeps, atomic quota reserve/release, project and profile deletion |
| `src/retention.ts` | 180-day sweep: warn, then delete |
| `src/r2-keys.ts`, `src/files.ts` | R2 key layout; serving stored objects with explicit types |
| `src/sanitize/html.ts` | allowlist HTML sanitizer (no DOM) |
| `src/routes/*` | session/profile/me, projects + members, project invites, invite redemption |
| `migrations/0001_init.sql`, `0002_search.sql` | schema, FTS5 |

Request pipeline, in order, and why:
1. Request id from `@cuny-ai-lab/cail-log` `correlationFromHeaders` (a client-supplied id is kept only if it is a lowercase UUIDv4/v7; otherwise a fresh one is minted). Echoed as `x-cail-request-id` and in every error body.
2. **Canonical origin**: if the request URL origin is not `CAIL_CANONICAL_ORIGIN`, the answer is a JSON `404` (workers.dev, previews and stray routes do not "exist"). Doorway builds forwarded URLs from its canonical origin (`new URL(path, config.canonicalOrigin)` in `apps/doorway/src/doorway.ts`), so this does not 404 real traffic. `workers_dev` and `preview_urls` are also `false` in `wrangler.jsonc`.
3. CSRF on `/api` mutations *before* identity, so a cross-site write learns nothing about whether it was signed in.
4. Identity: load both pinned verifier configs first (any failure is `503 identity_unavailable`, `x-should-retry: true`, even with no token), then: no app assertion `401 authentication_required` (+ `launch: /launch/manifold-companion`); bad signature, expired, wrong audience, malformed, missing-but-malformed keyring, or Gateway leg for another subject `401 invalid_credential`. The Gateway leg is kept in `Principal.credential` for the future CAIL Client; the app assertion is dropped.
5. `INSERT OR IGNORE INTO profiles` so any first authenticated request creates the (empty) profile.
6. Routes. Errors are `{error:{code,message,requestId,retryable}}`; unexpected exceptions become `internal_error` with only the error class logged, never the message.

Auth error bodies are the nested CAIL auth envelope built by `createCailAuthError` (the same shape the fleet's clients parse).

## 3. Data model

D1 schema is in `migrations/`. Everything is keyed on `subject` (`cail-` + 32 hex). Timestamps are Worker-written UTC ISO-8601 strings. IDs are UUIDv4 text.

| Table | Purpose / notable columns |
|---|---|
| `profiles` | `subject` PK, `display_name` (self-set), `theme_preference`, `onboarded`, **`storage_bytes`** (counter, charged to project *owners*), `last_seen_at` |
| `projects` | `owner_subject`, `project_type`, `default_language`, **`last_edited_at`** (retention clock), `retention_warned_at` |
| `project_members` | `(project_id, subject)` PK, `role` owner/editor/viewer; partial unique index = exactly one owner |
| `invites` | `token_hash` (SHA-256, token never stored), `role` editor/viewer, `expires_at`, `revoked_at`, `redeemed_by`, `redeemed_at` |
| `texts` | `name`, `status`, `sort_order`, `summary` (D1, capped), pointers `html_key`, `translation_key`, `source_pdf_key` + `*_bytes` |
| `pages` | `filename`, `page_number`, `ocr_text` (one page, route-capped far below the row limit), `ocr_model`, `image_key`, `image_bytes` |
| `text_versions` | `content_type` compiled/html/page, **`r2_key`**, `bytes`, `sha256`, `created_by` |
| `metadata` | Dublin Core, one row per text |
| `text_settings` | per-text prompt/model/`math_model`/temperature/max_tokens (legacy `settings`) |
| `export_settings` | per-project JSON (legacy `projects.export_settings`) |
| `annotations` | threaded (`parent_id`), `anchor_type`, `mentions`, resolved state |
| `notifications`, `notification_preferences` | in-app only; `email_enabled` reserved (default 0, unread by anything) |
| `text_fts` (FTS5) | `title`, `body` = extracted **plain text**, `text_id`/`project_id` unindexed; triggers delete rows with their text (including cascades) and follow renames |

### Changes from the legacy schema (`server/db.js`)

- Dropped: `users` (email, password_hash, role, status pending/approved/disabled, reset tokens, token_allowance, token_usage_reset_at), `api_usage_logs`/token ledger, `sessions.db`, `settings.token...`. Admin routes and all of auth go away (Admission and the Gateway own those jobs).
- `users.id INTEGER` becomes `profiles.subject TEXT`; every `user_id` becomes a subject FK.
- `project_shares` becomes `project_members` with an explicit `owner` row (authorization is one lookup, not "is owner OR has share").
- New `invites`; share-by-email and user search are gone by decision.
- `texts.html_content` and `text_versions.content` (unbounded) become R2 objects with pointers; `translation` moves to R2 too; `summary` stays in D1 (bounded).
- `projects.expires_at` becomes `last_edited_at` + `RETENTION_DAYS` (computed), plus `retention_warned_at`.
- `notification_preferences.email_*` become `inapp_*` + reserved `email_enabled`.
- **Foreign-key fix.** In the legacy schema `projects.user_id`, `text_versions.user_id`, `annotations.user_id`/`resolved_by` had no `ON DELETE` action, so `DELETE FROM users` failed for anyone with data. Here every reference to `profiles(subject)` is `CASCADE` (rows meaningless without the person: their projects, memberships, annotations, notifications, invites they created) or `SET NULL` (rows that belong to someone else's project but record who touched them: version author, resolver, invite redeemer). `test/migrations.test.ts` asserts this for every FK to `profiles`, and that deleting a profile with data in all those places succeeds with `PRAGMA foreign_key_check` clean.

### D1 limits and the D1/R2 split (verified from Cloudflare docs, 2026-11-09)

Source: <https://developers.cloudflare.com/d1/platform/limits/> (last updated Oct 30, 2026), read through the Cloudflare docs search.

| Limit | Value | Consequence here |
|---|---|---|
| Max string, BLOB or table **row size** | 2,000,000 bytes (2 MB) | Anything unbounded or possibly large goes to R2 (`html_content`, translations, version snapshots, PDFs, images). One OCR page (a few KB) and a bounded summary stay in D1. |
| Max SQL statement length | 100,000 bytes | A text body can never be inlined into a statement; bodies are bound parameters or R2. Statements stay short. |
| Max bound parameters per query | 100 | Bulk inserts (bulk-delete, reorder) chunk at <= 90 binds. |
| Queries per Worker invocation | 1000 (paid) / 50 (free) | `db.batch()` counts as **one** query; deletion loops batch. The Worker runs on the paid plan. |
| Max query result size | 50 MB, enforced from 2026-11-04 | List endpoints never return bodies; `SELECT` only needed columns, paginate. |
| Max SQL query duration | 30 s | FTS and list queries are indexed and paginated. |
| Columns per table | 100 | `metadata` has 17. |
| Batch limits | per-statement limits apply inside `db.batch()` | |

Row sizing: the largest D1 value we plan is `pages.ocr_text`; the OCR route will cap it at 256 KB (far below 2 MB, with a PDF-to-HTML page at the same cap). `text_fts.body` is capped at 500 KB per text when written (plain text only; the HTML itself is never indexed).

**Not locally enforced.** Miniflare/workerd does not enforce the 2 MB row limit (I tested: a 2.1 MB insert succeeds locally), so code must enforce its own caps; the local test suite cannot catch a row-size regression. The tests assert only what Miniflare enforces (foreign keys, FTS, cascades).

**FTS5 on D1: assumption, partly verified.** D1's docs recommend FTS5 (trigram tokenizer) for arbitrary-substring search on the "Use indexes" page, and Durable Object SQLite documents FTS5 support, but I did not find a D1 page that states FTS5 virtual tables are supported on remote D1 in so many words, and the docs search returned nothing on D1 and `CREATE VIRTUAL TABLE` specifically. Verified: it works under Miniflare/workerd (the migration, triggers and MATCH queries run in `test/lifecycle.test.ts` and `test/migrations.test.ts`). **Must be confirmed with a real `wrangler d1 migrations apply` against a scratch D1 before the first deploy** (HANDOFF open question 1). Fallback if it is refused: the same two columns in an ordinary table with a trigram-free `LIKE` on plain text (still far cheaper than `LIKE` over HTML).

### R2 key layout

```
p/{projectId}/t/{textId}/page/{pageId}      page image (browser-resized JPEG/PNG)
p/{projectId}/t/{textId}/source.pdf         original PDF (pdf_to_html)
p/{projectId}/t/{textId}/html               current html_content (sanitized on write)
p/{projectId}/t/{textId}/translation        current translation
p/{projectId}/t/{textId}/v/{versionId}      version snapshot bodies
p/{projectId}/t/{textId}/fig/{figureId}     extracted figure images
p/{projectId}/export/{exportId}             generated ZIP (short-lived)
```

All keys are built from server-generated UUIDs only, never user file names. Everything for a project shares the `p/{projectId}/` prefix, so project deletion and "delete my data" are prefix sweeps (`deleteR2Prefix`: list 1000, delete 1000, repeat). Original file names live in D1 (`pages.filename`) and are sanitized on download.

Stored objects are served through `src/files.ts`: the content type comes from the route's declared kind, never from the object or the uploader; every response has `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `private, no-store`, and HTML/Markdown/ZIP are `attachment`. Stored HTML is never served as an app page.

Lifecycle: no R2 lifecycle rule is needed for project data (the retention sweep owns it). `export/` objects should get a 1-day expiry rule; R2 lifecycle is bucket state, not Worker config (Media Tools documents the same), so it is a release-checklist item (HANDOFF).

## 4. Authorization

One function: `requireRole(db, subject, projectId, minRole)` in `src/authz.ts`. Every project-scoped route calls it exactly once before touching data. Non-members (and malformed or unknown ids) get a `404 not_found` identical in shape, so other people's projects are not disclosed; members below the needed role get `403 insufficient_role`. Authentication alone grants nothing.

| Route class | Minimum |
|---|---|
| read project, list members, (later) read texts/pages/versions/annotations/search/export | viewer |
| leave project (self-removal) | viewer |
| (later) edit text content, upload, OCR, annotate, revert version | editor |
| rename/delete project, remove others, create/list/revoke invites | owner |
| profile, `/session`, `/me/data` | self only (no project; subject comes from the verified principal, never from the request) |
| `POST /invites/redeem` | any signed-in person holding a valid token (no role yet by definition) |

`test/authz.test.ts` runs owner / editor / viewer / stranger against every project route and has a **route-coverage test**: it enumerates the Hono route table and fails if a `/projects/:id/...` route exists that the matrix does not list. Later phases must add rows to the matrix.

## 5. Sharing (invite links)

- Owner creates `POST /projects/:id/invites {role: editor|viewer, expires_in_days: 1..30 (default 7)}`. The response is the only time the token is shown. D1 stores `SHA-256(token)`; listings never include it. The link is `https://tools.ailab.gc.cuny.edu/manifold-companion/invite#t=<token>`: the token is in the **fragment** so it is never sent to a server, a log or a `Referer`. The client route `/invite` (later phase) reads it from `location.hash` and posts it to `/invites/redeem`.
- Redemption is atomic: one `UPDATE ... WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now` and one `INSERT ... SELECT` that only inserts if *this subject* now holds the claim, in one `db.batch()` transaction. Racing redeemers: exactly one wins (tested with three concurrent redeemers).
- Single use, bound to the redeemer's subject (`redeemed_by`). The same person retrying gets `200 already_redeemed`; anyone else gets `410 invite_used`. Already a member: `409 already_member`, invite not consumed. Role is the invite's role; an invite can never create an owner (CHECK constraint and validation).
- Revoke (`DELETE .../invites/:id`) is idempotent; a redeemed invite returns `409` (remove the member instead). Max 20 active invites per project.
- No user search and no share-by-email lookup exist anywhere. The member list shows only self-set display names and opaque subjects.

## 6. Spending guard and quotas

- **Per-person storage**: `profiles.storage_bytes`, default 500 MB (`STORAGE_QUOTA_BYTES`), charged to the **project owner** (a collaborator's upload counts against the project owner, so an editor cannot exhaust the owner's allowance without the owner's consent in having invited them, and cannot be charged for other people's projects; deleting the owner reclaims everything). `reserveStorage` is one atomic `UPDATE ... WHERE storage_bytes + ? <= quota`, so racing uploads cannot jointly overshoot (tested: 6 racing 300-byte reservations against 1000 -> exactly 3 succeed). Releasing on delete is clamped at 0. Order of operations for uploads (next phase): reserve -> `R2.put` -> insert row; on failure release.
- **Per-file cap** `MAX_FILE_BYTES` (10 MB), **per-project page cap** `MAX_PROJECT_PAGES` (300), `maxProjectsPerPerson` 100, 20 active invites per project, JSON bodies <= 2 MB (page-image JSON bodies for model calls get their own ~6 MB cap in the Gateway phase, like Media Tools). All are exposed read-only in `/api/session` so the client can pre-check.
- **No unattended bulk OCR.** OCR/HTML conversion is one page per request, started by a person (client-driven loop with a visible cancel; no server-side "run the whole document" GET, no SSE, no cron model calls). The Gateway's `/quota` (microdollars, `limit` / `estimated_used`) is shown in the UI; there is no app ledger. A page request does one Gateway attempt, no hidden retries, and honors `x-should-retry`.
- Reasoning-model output headroom (handoff notes): see section 8.

## 7. Retention

- Clock: `projects.last_edited_at`, bumped by every content edit (project update now; text/page/annotation writes will call a shared `touchProject`), which also clears `retention_warned_at`.
- **Visible in-app**: every project response carries `retention: {delete_after, warning, days_remaining}`; the dashboard shows a banner once `warning` is true (30 days before deletion, `RETENTION_WARN_DAYS`). `/session` exposes the policy (`days`, `warn_days`).
- **Cron** (`triggers.crons: ["17 6 * * *"]`, UTC daily): `scheduled()` runs `runRetentionSweep`. Phase 1 warns every project older than (180 - 30) days with one in-app notification and a `retention_warned_at` stamp, and deletes only projects older than 180 days that were warned at least 7 days earlier (so a missed cron or an imported project is always warned first). Bounded to 50 per run per phase; R2 failure leaves rows and the next day retries (deletion is R2-first, then one atomic D1 batch). Cron details verified in the Cloudflare docs: five-field UTC expressions, `scheduled()` handler, `wrangler.jsonc` `triggers.crons`, up to 15 minutes of runtime.
- **Delete my data** `DELETE /api/me/data {"confirm":"delete my data"}`: deletes every project the person owns (R2 prefix first, then rows, releasing bytes), then the profile; the `CASCADE`s remove memberships, annotations they wrote anywhere, notifications, preferences, invites they created; version authorship in others' projects becomes `NULL`. Re-runnable if interrupted. The person's next sign-in creates a fresh empty profile. Subrequest budget: roughly 4 R2/D1 calls per project; 100 projects fits well inside 1000.
- Unwarned email: see section 9. **A person who never returns never sees an in-app warning.** That is the main reason to build the email path.

## 8. Models and tasks

Model list comes from the Gateway catalog (`getCatalogSnapshot`, canonical prefix-free IDs), never from app config, filtered by capability and cached ~60 s per isolate (pattern from LanGames `models.ts`). No Bedrock/OpenRouter keys. The Gateway rejects PDF/file parts (`400 file_input_unsupported`), so **every page is sent as an image** (`image_url` with a data URI, like Media Tools `vision.ts`), rasterized in the browser.

| Task | Needs (catalog `capabilities`) | Input | Notes |
|---|---|---|---|
| `ocr` (image to Markdown) | `vision`, `text-generation` | one page image | Default = highest-ranked (`recommended`, then `order`) vision model. Media Tools currently uses `qwen3-vl-235b-a22b-instruct` and `gemma-4-26b-a4b-it`; do not hard-code, read the catalog. |
| `html_page` (PDF page to HTML) | `vision`, `text-generation` | page image + pdf.js text hint | Same default as OCR, with the PDF-to-HTML prompt. |
| `html_page_math` | `vision` **and** `reasoning` preferred | page image + text hint | The "math/tables" path. See below. |
| `html_cleanup` | `text-generation` | assembled HTML (text) | Text model; output sanitized on write. |
| `summary`, `translation` | `text-generation` | compiled text | Same capability filter as LanGames (the catalog also marks Whisper recommended, so filter on capability, not on `recommended`). |

### Mathematics-heavy PDF-to-HTML (required, retained)

The legacy app used Gemini 3 Flash via OpenRouter for page parsing and a separate "formula repair" pass. Design:

1. **Per-task model choice stored per text** (`text_settings.model` for the default vision task, `text_settings.math_model` for math pages), validated against the live catalog at request time (`model_not_allowed` if it is not offered now).
2. The page picker in the editor gets a per-page (and "apply to rest") toggle **"Math / tables page"**. When on, the request names the `math_model`. The UI lists candidates = catalog models with `vision` + `reasoning` (stronger first, by the Gateway's `order`); if none has both, it lists `vision` models and says so. The default `math_model` is the top such model; nothing is hard-coded.
3. Inputs improve accuracy without PDFs: the browser renders the page to a canvas at a larger scale for math pages (up to the Gateway/Doorway body cap; target <= 4 MB image like Media Tools `MAX_IMAGE_BYTES`), and sends the pdf.js text layer as a hint (as the legacy `textHint`).
4. **Output headroom** (handoff notes): for any model whose catalog entry has `reasoning`, `max_tokens = task_budget + 4000`; `enable_thinking: false` and `reasoning_effort: "low"` are sent **only** to reasoning models and only for non-math tasks (a non-reasoning model answered them with `400 capability_unsupported`); math pages leave thinking on. 4,000 headroom made all six reasoning models answer; larger was worse (a model reasoned past a two-minute timeout), so the cap is 4,000 and the per-request deadline is explicit. An empty reply with `finish_reason: "length"` is surfaced as its own error (`model_output_truncated`), never as success; the UI offers "retry this page with a different model".
5. Formulas: the model emits TeX in `$...$`/`$$...$$` (or MathML); the Worker sanitizes HTML on write, which **keeps MathML** (the allowlist includes `math`, `mi`, `mo`, `mfrac`, `msup`, `mtable`, ... and strips `annotation-xml`, `maction`, `href` on MathML), and the legacy server-side `temml` conversion for export stays (temml is pure JS; run in the Worker at export). The "formula repair" endpoint becomes a text-model call on the unresolved formulas only (cheap) rather than a second vision pass.
6. Spend guard: one page per request; a math page uses a stronger and costlier model, so the UI shows which model it will use and the Gateway quota before the first math page; nothing runs unattended.

Open: which catalog model is actually best for math is an empirical question (Media Tools kept a side-by-side doc, `docs/2026-09-model-comparison.md`); HANDOFF has a work package to measure it against a small math-PDF fixture with a real Gateway key before picking the default.

## 9. Email

### What I found

- **Who sends mail today.** Everything goes through **Amazon SES, owned by the Admission Worker** (`cail-tools-admission`). The sender is the constant `EMAIL_FROM = "ailab@gc.cuny.edu"` (`apps/admission/src/config.ts`). SES credentials live in Admission's Worker secrets; no other Worker holds them. Admission has an outbox (one SQLite Durable Object) with a delivery state machine, rate limits and idempotency, and Doorway ingests signed SES feedback (`POST /api/admission/ses-feedback`) to mark `delivered`/`bounced`/`complained`.
- **How other services use it.** Not by calling SES. They call **narrow, service-bound, private Admission entrypoints** with fixed scope: `AdmissionBugReports.submit` (Stem Splitter / Systems Mapping reports; recipient fixed by the binding), and `AdmissionHauntologiesAccountMail.send` (binding props fix `{app, origin}`; sender, subject and link origin fixed by Admission; per-recipient hourly and daily budgets; `delivery_unknown` on uncertain dispatch). Ticketing has its own reporter mail (`CAIL Ticketing` note). Maintenance notices send to "the verified identity-profile emails of everyone with current access" (so Admission can resolve subject -> email itself).
- **Policy.** The September 2026 decision (`Email Sending and Site Hosting on Cloudflare`) cancelled the Cloudflare Email migration: SES via Admission stays; do not reopen. A Gmail DMARC rejection of SES mail is documented and *not* repaired, so delivery to external Gmail recipients is unreliable; mail to CUNY addresses is the realistic target.
- **Does a mounted tool receive the user's email?** **No.** Doorway's identity JWT contract (`apps/doorway/config/contract/identity-jwt-claims-v1.json`) puts `email`, `given_name`, `family_name`, `nonce`, `auth_time` **only on the `cail:ticketing` audience**. App legs and `cail:gateway` legs carry `iss, aud, sub, log_sub, exp` (and `tool` on the Gateway leg). `@cuny-ai-lab/cail-identity`'s `CailIdentity` type has optional `email`/`name` fields but Doorway does not populate them for tool audiences. The only contact-bearing path is `WorkerIdentity.identities(token, "private_report")`, allowlisted to two named Workers (Admission PR #376). The legacy app asked for an email at registration; that data does not exist in this stack.
- Legacy sender was a separate SES identity (`manifold-companion@cuny.qzz.io`, `SES_FROM_EMAIL`); this stack should not recreate it.

### Recommendation

**Preferred (A): an Admission-owned, subject-addressed notice capability.** Add a private entrypoint to Admission, in the family of `AdmissionHauntologiesAccountMail`:

```
AdmissionToolNotice.send({ kind, subject, requestId, fields })
  binding props (fixed by the service binding): { app: "manifold-companion", origin: "https://tools.ailab.gc.cuny.edu/manifold-companion/" }
```

- The tool passes the **opaque subject and a fixed `kind`**, never an address. Admission resolves the recipient from the linked identity profile (the same lookup the maintenance notice uses), fixes the sender (`ailab@gc.cuny.edu`), subject line and template per `kind`, builds the link from the bound origin, and returns `accepted | skipped_unlinked | throttled | delivery_unknown`. People with no linked profile are skipped, not guessed at.
- The tool never sees or stores an email, adds no PII to D1 and holds no mail credential; this matches the fleet's "no direct identifiers" rule and the "recipient fixed by the capability" pattern.
- Kinds worth sending: `retention_warning` (the important one), `comment_mention`, `comment_reply`, `invite_redeemed` (to the owner). Not OCR-complete (user is present).
- Tool-side opt-in: `notification_preferences.email_enabled` default 0 (already in the schema, unread); the retention warning is sent regardless unless the person opted out, because it concerns their own data.
- Idempotency (`requestId` UUID), per-recipient hourly/daily budgets and the `delivery_unknown` replay semantics come from the existing Admission machinery.

Dependencies: (1) a new Admission entrypoint + schema/enum additions (message kinds are enumerated in the `email_deliveries` CHECK, `EmailMessageKind`, the subject table, the admin reader and the agent contract; the KB's v21 migration notes list every place), reviewed by Stephen Zweibel (Admission is in his stewardship portfolio); (2) a service binding in this Worker's `wrangler.jsonc` with the fixed props; (3) deploy order receiver-first (Admission, then this Worker); (4) a Doorway-independent change (no Doorway edit); (5) the unresolved Gmail DMARC deliverability caveat applies.

**Fallback (B), what exists today:** in-app notifications only (including the retention warning). Acceptable for comments, weak for retention.

**Not recommended:** (C) giving this Worker SES credentials or its own sender (credential sprawl, new sender identity, contradicts the SES-owned-by-Admission model); (D) asking people to type an email (an arbitrary-recipient relay and unverified); (E) adding `email` to the app-audience claims (changes a shared identity contract owned by Stephen, and puts PII in every request to every tool).

Decision needed from the owner/Stephen: is B acceptable for launch, with A as a fast follow? My recommendation is yes for launch (the retention clock is 180 days, so a warning email is needed months after launch), but A should be requested from Admission now since it is a cross-repo change with lead time.

## 10. Model-call and error mechanics to reuse (next phases)

From `@cuny-ai-lab/cail-client` >= 6.3.0 (installed 6.3.0): `createCailClient({app: "manifold-companion", baseUrl, fetchImpl: GATEWAY binding})`, JWT credential goes in `x-cail-identity-jwt` (the client does this; do not send Bearer), one attempt, no redirects, cancellation via `c.req.raw.signal` (`enable_request_signal` is set). Error envelopes need `param`; use `@cuny-ai-lab/cail-client/testing` helpers (`quotaSnapshotBody()`) in tests. Quota fields are `limit` and `estimated_used` in microdollars (divide by 1e6). `X-CAIL-App` attribution comes from the client `app` option and needs Gateway to know the tool (section 12, open question).

## 11. Legacy route map: every legacy route, its Worker equivalent, and client work

Base: legacy `/api/...` becomes `/manifold-companion/api/...`. "Phase" refers to `HANDOFF.md` work packages (WP). **Bold** = built in phase 1.

### Auth, profile, settings (`routes/auth.js`, `index.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `POST /auth/register`, `/login`, `/logout`, `/forgot-password`, `/reset-password`, `/change-password` | **removed** | CUNY Login via Doorway; Admission membership replaces approval. Client: delete Login/Register/Forgot/Reset pages, session context calls `/session`; on `401 authentication_required` or `session_invalid` navigate (full page) to `/launch/manifold-companion` (Browser Sign-In contract). |
| `GET /auth/me` | **`GET /api/session`** | subject-keyed profile + limits + storage + retention policy |
| `PUT /auth/profile` | **`PUT /api/profile`** | display_name, theme, onboarded; no email/password |
| `GET/PUT /auth/settings` | **`PUT /api/profile`** (theme, onboarded) | |
| `GET /defaults` | `GET /api/models` (WP3) | live Gateway catalog filtered by capability; replaces env-var defaults |
| `GET /projects/usage` | `GET /api/quota` (WP3) | proxies Gateway `/quota`; token ledger deleted |

### Admin (`routes/admin.js`) and users (`routes/users.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `GET/POST /admin/users`, `PUT /admin/users/bulk-status`, `/:id/status`, `/:id/name`, `/:id/token-allowance`, `POST /:id/reset-usage`, `DELETE /admin/users/:id`, `GET /admin/usage` | **removed** | Admission and Gateway own membership and allowances. `DELETE user` is replaced by self-service `DELETE /api/me/data` (**built**), which also fixes the legacy FK failure. Client: delete `AdminPanel`. |
| `POST/GET/DELETE /admin/backups...` | **removed** | D1 Time Travel / `d1 export` by the operator; no in-app backups. |
| `GET /users/search` | **removed** | No user search by decision. Mentions (below) are restricted to current project members. |

### Projects (`routes/projects.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `GET /projects` | **`GET /api/projects`** | membership-scoped, includes `role` and `retention` |
| `POST /projects` | **`POST /api/projects`** | |
| `GET /projects/:id` | **`GET /api/projects/:id`** | |
| `PUT /projects/:id` | **`PUT /api/projects/:id`** | owner |
| `DELETE /projects/:id` | **`DELETE /api/projects/:id`** | owner; R2 prefix sweep + quota release |
| `PUT /projects/:id/texts/reorder` | `PUT /api/projects/:id/texts/reorder` (WP1) | editor |

### Shares (`routes/shares.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `GET /projects/:id/shares` | **`GET /api/projects/:id/members`** | |
| `POST /projects/:id/shares` (by email) | **`POST /api/projects/:id/invites`** + **`POST /api/invites/redeem`** | owner-generated links; no email lookup |
| `PUT /projects/:id/shares/:shareId` (role) | `PUT /api/projects/:id/members/:subject` (WP1) | owner; **not built in phase 1** (remove + re-invite works meanwhile) |
| `DELETE /projects/:id/shares/:shareId` | **`DELETE /api/projects/:id/members/:subject`** | owner removes, member leaves |
| (none) | **`GET /api/projects/:id/invites`**, **`DELETE .../invites/:inviteId`** | list and revoke |

### Texts, pages, files (`routes/texts.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `POST /projects/:pid/texts` | `POST /api/projects/:pid/texts` (WP1) | editor; page cap check |
| `GET /texts/:id`, `PUT /texts/:id`, `DELETE /texts/:id` | same under `/api` (WP1) | delete frees R2 + bytes + FTS (trigger) |
| `POST /texts/:id/upload` (multer, **sharp**) | `POST /api/texts/:id/pages` (WP2) | multipart or raw body streamed to R2 with byte cap and quota reserve. **Client replacement for sharp**: the browser resizes (max 2048 px) and re-encodes to JPEG via canvas, handles EXIF orientation (`createImageBitmap(..., {imageOrientation:'from-image'})`), and HEIC via `heic2any`/native decode, before upload. The Worker validates magic bytes (JPEG/PNG/WebP only) and rejects anything else. TIFF/BMP: client converts. |
| `POST /texts/:id/pdf-upload` | `PUT /api/texts/:id/source-pdf` + `PUT /api/texts/:id/html` (WP2/WP4) | streamed to R2 (`source.pdf`); HTML sanitized on write |
| `POST /texts/:id/page-images` | `POST /api/texts/:id/pages` (WP2) | same endpoint family |
| `GET /texts/:id/page-image/:filename`, `GET /texts/:id/image/:filename` | `GET /api/texts/:id/pages/:pageId/image` (WP2) | via `serveBody`, by id not filename |
| `GET /texts/:id/source-pdf/:filename` | `GET /api/texts/:id/source-pdf` (WP2) | |
| `GET /texts/:id/pages`, `POST /texts/:id/pages/:pageId` (save OCR), `DELETE .../pages/:pageId`, `PUT .../pages/reorder` | same family (WP1) | editor; saving bumps `last_edited_at`, re-indexes FTS |
| `GET /texts/:id/result`, `GET/PUT /texts/:id/html`, `POST /texts/:id/save` | same family (WP1/WP4) | `PUT html` runs `sanitizeHtml`, writes R2 + version row, updates FTS plain text |
| `GET/POST /texts/:id/metadata` | same family (WP1) | Dublin Core |
| `GET/POST/DELETE /texts/:id/settings` | `.../settings` (WP1) | model ids validated against catalog |
| `GET /search` | `GET /api/search?q=` (WP1) | **FTS5 over plain text**, membership-scoped by `project_id IN (my projects)`, snippets via `snippet()`; query sanitized to FTS syntax |
| `GET /texts/:id/versions`, `GET .../versions/:versionId`, `POST .../versions/:versionId/revert` | same family (WP1) | bodies fetched from R2; revert = new version |
| `POST /texts/:id/split`, `POST /projects/:pid/texts/merge`, `.../bulk-delete`, `.../bulk-status` | same family (WP1) | chunk D1 binds <= 90; R2 copies for merge/split; quota re-check |

### OCR and LLM (`routes/ocr.js`, `routes/llm.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `GET /texts/:id/ocr` (**SSE loop** over all pages, Bedrock) | **removed**; `POST /api/texts/:id/pages/:pageId/ocr` (WP3) | One page per request, started by a person. **Client replacement for the SSE loop**: the browser drives the page list sequentially (concurrency 1, visible progress and Cancel via `AbortController`, stop on first quota/`429`/`503` error with `x-should-retry` honored). No server-side bulk run. |
| `POST /texts/:id/ocr-single` | same new endpoint (WP3) | |
| `GET/POST/PUT /texts/:id/summary` | same family (WP3) | `text-generation` model chosen from catalog; result stored in D1 (capped) |
| `GET/POST/PUT /texts/:id/translation` | same family (WP3) | translation body to R2 |
| `POST /texts/:id/formula-repair` | same family (WP4) | text model on the unresolved formulas only |
| `POST /texts/:id/pdf-parse-page` (**OpenRouter**, accepts native PDF base64, **`pdftohtml -xml` figure extraction**) | `POST /api/texts/:id/pages/:pageNumber/html` (WP4) | Page **image** only (Gateway rejects PDF parts). **Client replacement for pdftohtml**: pdf.js in the browser renders each page to a canvas and extracts embedded image XObjects/figure regions via `page.getOperatorList()` (or crops figure bboxes from the high-res canvas), uploads them as figure assets (`fig/`), and sends the text layer as a hint. Math pages use the math model (section 8). |
| `POST /texts/:id/pdf-cleanup` | `POST /api/texts/:id/html/cleanup` (WP4) | text model; output sanitized |

### Export (`routes/export.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `GET/POST /projects/:pid/export-settings` | same family (WP5) | `export_settings` table |
| `POST /projects/:pid/export` (**archiver** ZIP, `temml` MathML) | `POST /api/projects/:pid/export` (WP5) | **Replacement for archiver**: build the ZIP in the Worker with `fflate` (pure JS, workerd-safe) into R2 `export/` (1-day lifecycle) and return a short-lived authenticated download, or stream it; a 300-page project is well below Worker memory only if images are streamed entry by entry (design the writer as `fflate` streaming `Zip` with R2 `get().body`). Fallback if memory is a problem: client-side `jszip`/`fflate` assembling from per-object downloads. `temml` runs in the Worker. |

### Annotations (`routes/annotations.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `GET /texts/:id/mentions/users` | `GET /api/texts/:id/mentions` (WP6) | **project members only**, display names |
| `GET/POST /texts/:id/annotations`, `GET/PUT/DELETE .../:annotId`, `POST .../resolve`, `.../unresolve`, `.../replies` | same family (WP6) | viewer reads; editor writes (legacy allowed viewers to comment: decide, HANDOFF Q6); author-or-owner edit/delete |

### Notifications (`routes/notifications.js`)

| Legacy | Worker | Notes |
|---|---|---|
| `GET /notifications`, `/unread-count`, `POST /:id/read`, `/read-all` | same (WP6) | subject-scoped |
| `GET/PUT /notifications/preferences` | same (WP6) | in-app flags + reserved `email_enabled` |

## 12. Doorway mount changes needed in `cail-tools-admission` (not made now)

Modelled on the Media Tools mount (Admission PR #181) and the LanGames mount (draft PR #234), read from a shallow clone of `CUNY-AI-Lab/cail-tools-admission` at `1bf54e0`. Receiver-first: deploy this Worker, read back `ManifoldCompanionReadiness.getReadiness()`, then release the mount (open it as a draft until the readback is green; every bound service is required when Doorway loads its configuration, so a mount released before its Worker exists fails the deploy).

Files in `cail-tools-admission/apps/doorway` (unless noted):

1. `wrangler.toml`: `[[services]] binding = "MANIFOLD_COMPANION"`, `service = "cail-manifold-companion"`.
2. `src/config.ts`: add `MANIFOLD_COMPANION?: ServiceFetcher` to the env interface, `manifoldCompanion: ServiceFetcher` to `DoorwayConfig`, and `manifoldCompanion: requiredService(env.MANIFOLD_COMPANION, "MANIFOLD_COMPANION")` where the config is built.
3. `src/policy.ts`: add `"manifold-companion-api"` (prefix `/manifold-companion/api`, authenticated, `requestKind: "api"`, `identityMode: "jwt"`, `toolId: "manifold-companion"`, `audience: "cail:manifold-companion"`, `gatewayIdentity: true`) and `"manifold-companion-page"` (prefix `/manifold-companion`, `requestKind: "page"`, same identity fields) to `GATEWAY_ROUTE_CONTRACTS`. **Pin the routes by name**: `validateGatewayRoute` returns early for any route without `gatewayIdentity` unless `toolId === "media-tools"` or the name starts with `media-tools-`; extend that guard to also cover `manifold-companion` (per the "Working notes from the LanGames mount": without it, dropping the Gateway leg or making the route public still parses as valid). **Write the mutation test first.**
4. `src/doorway.ts`: `MANIFOLD_COMPANION_ROUTES = new Set(["manifold-companion-page", "manifold-companion-api"])`, add `"manifoldCompanion"` to `MountOwningService` and one row to the `MOUNT_OWNING_SERVICES` lookup (`boundServiceTarget` sits at the lint complexity limit: no new `if`). Doorway forwards the **original** path including `/manifold-companion`, which is what this Worker expects.
5. `src/identity.ts`: add `"manifold-companion"` to `GATEWAY_TOOLS` so the Gateway leg carries `tool: "manifold-companion"` for usage attribution; and `config/contract/identity-jwt-claims-v1.json`: add it to the `tool` enum. **Cross-repo**: the Gateway/Model Access must tolerate or know the new `tool` value (open question 3); LanGames' pending PR is the precedent to check.
6. `config/route-policy.json`: in `tools[]` add `{"id":"manifold-companion","label":"Manifold Companion","steward":"CUNY AI Lab","landingPath":"/manifold-companion/","listed":true}` (the Tools portal card renders from this); in `routes[]` add the two routes exactly as in item 3 (landing path must be a protected page; only a visible top-level navigation starts CUNY Login, background requests get a local `401` with the launch path `/launch/manifold-companion`).
7. `scripts/release/doorway.sh`: add `check_service MANIFOLD_COMPANION cail-manifold-companion ""`, add `"MANIFOLD_COMPANION"` to the exact binding-set list, and add probes `probe_mounted_auth "$origin/manifold-companion/api/session" '/launch/manifold-companion'` plus the forged-header variant (`x-cail-identity-jwt: caller-forgery` / `x-cail-gateway-identity-jwt: caller-forgery`). (Media Tools' probe uses `/media/api/health`, which is not a receiver health endpoint; use `/session`.)
8. Tests: `vitest.config.ts` (`MANIFOLD_COMPANION: "ManifoldCompanionDouble"`), `test/runtime/products.ts` (a `ManifoldCompanionDouble` WorkerEntrypoint, product id `"manifold-companion"`), `test/runtime/worker.ts` (export it), `test/decision.test.ts` (cases `/manifold-companion/api`, `/manifold-companion/api/projects`, `/manifold-companion`, `/manifold-companion/`, `/manifold-companionx` -> denied/page as Media's `/medial`, `/media-tools` cases), `test/runtime/identity-legs.test.ts` (leg audiences, lifetimes, header and cookie stripping, forged-identity denial, missing-binding failure), and `/test/integration/release-components.test.ts` (binding list + the anonymous `401` fixture).
9. Docs: `docs/workflows/README.md` new "Manifold Companion mount" section in the Media Tools format (owner, affected action, deploy order, verification), plus the `apps/doorway/README.md` / `AGENTS.md` product lists.
10. Admission membership: protected routes are membership-gated by Doorway at request time (Integration Contract); no Admission schema change is needed for the mount itself. Confirm that a route with `gatewayIdentity: true` is automatically membership-checked (open question 4).
11. Verification after release: CUNY Login at `/manifold-companion/`, `GET /manifold-companion/api/session` returns the subject-keyed profile, one real OCR page, the allowance moving on `/usage`, session-expiry navigation, and `workers.dev` returning 404.

Not needed for phase 1: Doorway changes for email (design A needs Admission only), Worker Sign-In (unproven; the Doorway mount is the default).

## 13. Verified versus assumed

Verified from Cloudflare docs (search tool, 2026-11-09): D1 limits table (2 MB row, 100 KB statement, 100 binds, 1000 queries/invocation on paid, 50 MB result size from 2026-11-04, `db.batch()` counts as one query, 30 s query); D1 migrations/`defer_foreign_keys`; Cron Triggers (UTC, `scheduled()`, `wrangler.jsonc` `triggers.crons`, 15-minute duration); FTS5 documented for Durable Object SQLite and referenced for D1 only via the trigram best-practice note.

Verified by running: everything under `worker/test` in workerd via `@cloudflare/vitest-plugin` (real Hono app, real CAIL identity verification with the test issuer, D1 and R2 in Miniflare); `wrangler deploy --dry-run`; sanitizer output re-parsed by workerd's HTMLRewriter.

Assumed / not verified: FTS5 virtual tables on **remote** D1; the 2 MB row limit (not enforced locally); Doorway's behavior with request bodies above a few MB over the service binding; Gateway acceptance of `tool: "manifold-companion"`; R2 behavior at 1000-key list/delete (documented API limits, unexercised with real R2); real-Doorway integration (no Doorway in this environment); real Gateway calls (none made).
