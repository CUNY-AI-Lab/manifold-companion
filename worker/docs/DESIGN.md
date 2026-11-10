# Manifold Companion on the CAIL stack: design

Status (2026-11-09): Worker, browser client and tests built; not deployed. `HANDOFF.md` says what is done, stubbed and missing, and has the deploy checklist.
Branch `cail-stack`. The legacy Express/SQLite app on `main` is untouched and keeps running on its old host.

## 1. What this is

A Cloudflare Worker (Hono, TypeScript) in `worker/`, mounted by CAIL Doorway at
`https://tools.ailab.gc.cuny.edu/manifold-companion/`, audience `cail:manifold-companion`, **person-funded**: Doorway sends
an app assertion plus a same-subject `cail:gateway` leg; model spend lands on the signed-in person's own Gateway budget.
It serves its own fork of the React client from `worker/client/` (built to `worker/client/dist`, Vite `base` `/manifold-companion/`); the legacy `client/` is unchanged and keeps serving the Express app on `main`.

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
          ├─ /health/live, /health/ready, ManifoldCompanionReadiness RPC (Doorway release probe),
          │  (binding-only: outside the mount, never forwarded by Doorway);
          │  /manifold-companion/api/health behind sign-in (verdict only; readiness includes the
          │  Gateway catalog read through the GATEWAY binding), */15 cron self-check
          ├─ scheduled: daily retention sweep
          ├─ D1  (DB)     relational data; FTS5 created at runtime when available
          ├─ R2  (FILES)  uploads, large text, version bodies
          └─ GATEWAY service binding ► cail-model-api   (catalog, chat completions, quota)
```

## 2. Files (as built)

| File | Role |
|---|---|
| `src/env.ts` | `Env` type, config validation, limits (quota, per-file, page cap, retention), `BASE_PATH` |
| `src/identity.ts` | pinned verifier config (cached, failures never cached) then both legs; forwards only the Gateway leg |
| `src/csrf.ts` | exact-Origin check; absent Origin or Referer-only is rejected |
| `src/errors.ts`, `src/body.ts` | stable error envelope (with `gatewayRequestId` when the Gateway answered); bounded streaming body reader with a size-proportional read deadline |
| `src/security.ts` | CSP, `nosniff`, referrer/permissions/HSTS, cache policy |
| `src/app.ts` | middleware order, route mounting, SPA fallback, `onError` |
| `src/authz.ts` | `requireRole` / `requireTextRole`: the only project authorization checks |
| `src/storage.ts` | quota reserve/release, rows-first project deletion with cleanup tombstones, tombstone sweeps |
| `src/content.ts`, `src/text-ops.ts` | R2-backed content with compare-and-set writes, versions and pruning, page text, search text; text delete/split/merge |
| `src/uploads.ts`, `src/routes/uploads.ts` | sized raw uploads (`?size=&filename=`), magic-byte sniffing, page images, source PDF, figures |
| `src/search.ts` | one search function: FTS5 (created at runtime) or `LIKE` over extracted plain text |
| `src/gateway.ts`, `src/models.ts`, `src/prompts.ts`, `src/model-output.ts` | Gateway client, catalog menus, prompts, deterministic output cleanup |
| `src/routes/tasks.ts`, `src/routes/models.ts` | model tasks (one unit per request), `/models`, `/quota` |
| `src/export.ts`, `src/routes/export.ts` | streamed Manifold ZIP, export settings |
| `src/routes/annotations.ts`, `src/routes/notifications.ts`, `src/notify.ts` | comments, mentions, in-app notifications |
| `src/retention.ts` | daily sweep: warn, guarded delete, tombstone re-sweep |
| `src/logging.ts`, `scripts/check-logging.sh` | cail-log event catalog; CI gate against any other logging |
| `src/sanitize/html.ts` | allowlist HTML sanitizer (no DOM), MathML subset |
| `src/r2-keys.ts`, `src/files.ts` | R2 key layout; serving stored objects with explicit types |
| `migrations/0001`..`0010` | schema (see section 3) |
| `client/` | the browser app (React, Vite, Tailwind); `client/e2e/` the Playwright journeys |

Request pipeline, in order, and why:
1. Request id from `@cuny-ai-lab/cail-log` `correlationFromHeaders` (a client-supplied id is kept only if it is a lowercase UUIDv4/v7; otherwise a fresh one is minted). Echoed as `x-cail-request-id` and in every error body.
2. **Canonical origin**: if the request URL origin is not `CAIL_CANONICAL_ORIGIN`, the answer is a JSON `404` (workers.dev, previews and stray routes do not "exist"). Doorway builds forwarded URLs from its canonical origin (`new URL(path, config.canonicalOrigin)` in `apps/doorway/src/doorway.ts`), so this does not 404 real traffic. `workers_dev` and `preview_urls` are also `false` in `wrangler.jsonc`.
3. CSRF on `/api` mutations *before* identity, so a cross-site write learns nothing about whether it was signed in.
4. Identity: load both pinned verifier configs first (any failure is `503 identity_unavailable`, `x-should-retry: true`, even with no token), then: no app assertion `401 authentication_required` (+ `launch: /launch/manifold-companion`); bad signature, expired, wrong audience, malformed, missing-but-malformed keyring, Gateway leg for another subject, or a verified app leg with no Gateway leg at all (a Doorway route-policy fault; `authentication_required` would loop the browser through the launch path) `401 invalid_credential`. The Gateway leg is kept in `Principal.credential` and is the only credential forwarded; the app assertion is dropped.
5. `INSERT OR IGNORE INTO profiles` so any first authenticated request creates the (empty) profile.
6. Routes. Errors are `{error:{code,message,requestId,retryable}}`; unexpected exceptions become `internal_error` and only the error class is logged (through cail-log, `src/logging.ts`), never the message.

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
| `text_versions` | `content_type` compiled/html/page, **`r2_key`**, `bytes`, `sha256`, `created_by`, `reason` (0007: the action that replaced this content: save, ocr, conversion, restore). Kept 50 per text and type, page versions 20 per page |
| `metadata` | Dublin Core, one row per text |
| `text_settings` | per-text prompt/model/`math_model`/temperature/max_tokens (legacy `settings`) |
| `export_settings` | per-project JSON (legacy `projects.export_settings`) |
| `annotations` | threaded (`parent_id`), `anchor_type`, `mentions`, resolved state |
| `notifications`, `notification_preferences` | in-app only; `email_enabled` reserved (default 0, unread by anything) |
| `figures` | figure crops of a PDF-to-HTML text (`filename`, `image_key`, sniffed `image_type`, `bytes`, `width`, `height`) |
| `r2_cleanup` | deletion tombstones: an R2 prefix whose rows were deleted; swept at once and again by the cron, forgotten after a day |
| `transfer_offers` (0008) | one pending ownership offer per project (`project_id` UNIQUE), `from_subject`, `to_subject`, `expires_at`; `claim_nonce`/`claim_bytes` exist only inside the accepting batch. `projects.transfer_nonce` marks the accept that last moved the project |
| `storage_reservations` (0009, 0010) | quota held for bytes not yet in a row: `subject` (whose counter holds it), `project_id` (whose bytes they are), `bytes`, `expires_at` (1 h) |
| `text_fts` (FTS5, **runtime**) | `title`, `body` = `texts.search_text`; created with its triggers and a backfill by `ensureSearchIndex()` when D1 accepts FTS5, never by a migration |

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

**FTS5 on remote D1 is confirmed by test** (2026-11-10: on a scratch remote D1, `CREATE VIRTUAL TABLE ... USING fts5` and a `MATCH` query worked), though not by the D1 documentation (re-checked 2026-11-09: the docs list FTS5 for Durable Object SQLite and recommend the trigram tokenizer on the D1 "Use indexes" page, but no D1 page states that `CREATE VIRTUAL TABLE ... USING fts5` is accepted). The runtime design stays: a migration D1 refused would block every later migration and the deploy, so **no migration creates an FTS5 object**. `ensureSearchIndex()` in `src/search.ts` creates the table, its two triggers and a backfill from `texts.search_text`, idempotently, once per isolate (a failure is remembered for ten minutes). Search uses FTS5 when it exists and otherwise a `LIKE` scan of `texts.search_text` (capped plain text, never HTML), behind the one function `searchTexts`. `test/migrations.test.ts` fails if a migration mentions FTS5. `0002_search.sql` was rewritten for this before it was ever applied to a real database.

### R2 key layout

```
p/{projectId}/t/{textId}/page/{pageId}      page image (browser-resized JPEG/PNG)
p/{projectId}/t/{textId}/source.pdf         original PDF (pdf_to_html)
p/{projectId}/t/{textId}/c/{kind}/{rev}      html / compiled / translation, a new key per write (the previous object becomes the version snapshot)
p/{projectId}/t/{textId}/pdf/{rev}          source PDF (revisioned)
p/{projectId}/t/{textId}/v/{versionId}      page-text version snapshots
p/{projectId}/t/{textId}/fig/{figureId}     extracted figure images
p/{projectId}/export/{exportId}             generated ZIP (short-lived)
```

All keys are built from server-generated UUIDs only, never user file names. Everything for a project shares the `p/{projectId}/` prefix. Deletion is **rows first**: one D1 batch releases the owner's bytes, writes an `r2_cleanup` tombstone for the prefix and deletes the rows; then the prefix is swept (`deleteR2Prefix`: list 1000, delete 1000, repeat). A failed sweep, or an object an in-flight upload wrote after it, is caught by the cron, which sweeps every tombstone again and forgets it a day after creation. Original file names live in D1 (`pages.filename`) and are sanitized on download.

Stored objects are served through `src/files.ts`: the content type comes from the route's declared kind, never from the object or the uploader; every response has `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `private, no-store`, and HTML/Markdown/ZIP are `attachment`. Stored HTML is never served as an app page.

Lifecycle: no R2 lifecycle rule is needed for project data (the retention sweep owns it), and exports are streamed, never stored, so there is no `export/` object to expire. One bucket rule is still worth setting: abort incomplete multipart uploads after 1 day (the Worker does not use multipart today; the rule is a guard).

## 4. Authorization

One function: `requireRole(db, subject, projectId, minRole)` in `src/authz.ts`. Every project-scoped route calls it exactly once before touching data. Non-members (and malformed or unknown ids) get a `404 not_found` identical in shape, so other people's projects are not disclosed; members below the needed role get `403 insufficient_role`. Authentication alone grants nothing.

| Route class | Minimum |
|---|---|
| read project, list members, read texts/pages/versions/annotations/search, export, edit or delete one's own comment | viewer |
| leave project (self-removal) | viewer |
| edit text content, upload, run model tasks, comment, reply, resolve, revert a version, save export settings | editor |
| rename/delete project, remove others, change a member's role, offer/view/revoke an ownership transfer, create/list/revoke invites, delete anyone's comment | owner |
| profile, `/session`, `/me/data` | self only (no project; subject comes from the verified principal, never from the request) |
| `POST /invites/redeem` | any signed-in person holding a valid token (no role yet by definition) |

`test/authz.test.ts` runs owner / editor / viewer / stranger against every project route and has a **route-coverage test**: it enumerates the Hono route table and fails if a `/projects/:id/...` route exists that the matrix does not list. Every new route must add a row (text-scoped routes included).

## 5. Sharing (invite links)

- Owner creates `POST /projects/:id/invites {role: editor|viewer, expires_in_days: 1..30 (default 7)}`. The response is the only time the token is shown. D1 stores `SHA-256(token)`; listings never include it. The link is `https://tools.ailab.gc.cuny.edu/manifold-companion/invite#t=<token>`: the token is in the **fragment** so it is never sent to a server, a log or a `Referer`. The client route `/invite` reads it from `location.hash` and posts it to `/invites/redeem`.
- Redemption is atomic: one `UPDATE ... WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now` and one `INSERT ... SELECT` that only inserts if *this subject* now holds the claim, in one `db.batch()` transaction. Racing redeemers: exactly one wins (tested with three concurrent redeemers).
- Single use, bound to the redeemer's subject (`redeemed_by`). The same person retrying gets `200 already_redeemed`; anyone else gets `410 invite_used`. Already a member: `409 already_member`, invite not consumed. Role is the invite's role; an invite can never create an owner (CHECK constraint and validation).
- Revoke (`DELETE .../invites/:id`) is idempotent; a redeemed invite returns `409` (remove the member instead). Max 20 active invites per project.
- No user search and no share-by-email lookup exist anywhere. The member list shows only self-set display names and opaque subjects.

## 6. Spending guard and quotas

- **Per-person storage**: `profiles.storage_bytes`, default 500 MB (`STORAGE_QUOTA_BYTES`), charged to the **project owner** (a collaborator's upload counts against the project owner, so an editor cannot exhaust the owner's allowance without the owner's consent in having invited them, and cannot be charged for other people's projects; deleting the owner reclaims everything). `reserveStorage` is one atomic `UPDATE ... WHERE storage_bytes + ? <= quota`, so racing uploads cannot jointly overshoot (tested: 6 racing 300-byte reservations against 1000 -> exactly 3 succeed). Releasing on delete is clamped at 0. Uploads: declared size -> cheap checks -> atomic reserve -> read at most that many bytes -> magic-byte sniff -> `R2.put` -> conditional insert (caps re-checked inside the statement); any failure deletes the object and releases the reservation.
- **Per-file cap** `MAX_FILE_BYTES` (10 MB), **per-project page cap** `MAX_PROJECT_PAGES` (300), `maxProjectsPerPerson` 100, 20 active invites per project, JSON bodies <= 2 MB (document and page-image bodies <= 6 MB; a page image sent to a model <= 4 MiB). All are exposed read-only in `/api/session` so the client can pre-check.
- **No unattended bulk OCR.** OCR/HTML conversion is one page per request, started by a person (client-driven loop with a visible cancel; no server-side "run the whole document" GET, no SSE, no cron model calls). The Gateway's `/quota` (microdollars, `limit` / `estimated_used`) is shown in the UI; there is no app ledger. A page request does one Gateway attempt, no hidden retries, and honors `x-should-retry`.
- Reasoning-model output headroom (handoff notes): see section 8.

### Storage accounting (every path, one invariant)

**Invariant.** For every person S, at every committed state of D1:

`profiles.storage_bytes(S) = Σ bytes the rows of the projects S owns account for (projectBytesSql: texts' html, translation, compiled and source-PDF bytes; pages' image bytes; text_versions' bytes; figures' bytes) + Σ storage_reservations held by S`

(The recount deletes expired reservations before it applies the formula, so between recounts "held" means every reservation row with that subject.)

Three rules make it hold:
1. Every change to the counter happens in the same D1 transaction (one statement or one batch) as the change to the rows or reservations it reflects.
2. Every follow-up statement in such a batch is conditioned on a value unique to that request (a new row id, a new R2 key, a nonce), so a repeated or concurrent request can never apply it twice.
3. The person charged is named **in SQL, as the transaction sees it** (`ownerSql` in `src/storage.ts`: the project's `owner_subject`; for a reservation, its `subject`), never the owner read when the request was authorized. A transfer can commit between a request's authorization and its writes.

| Path | What happens to the counter, and where |
|---|---|
| Reserve (before any bytes are read or written) | `reserveStorage(env, projectId, bytes)`: one batch inserts a `storage_reservations` row for the project's current owner only if counter + bytes <= quota, then raises the counter of that row's subject only if the row exists. Concurrent reservations serialize; none overshoots. TTL 1 h. A missing project is 404. |
| Commit (the row is written) | `commitReservation`, appended to the batch that writes the row, both statements only if that batch wrote the row (page or figure id, new content key, version id, every new page id of a split/merge): (1) if the reservation is gone, charge the project's owner for the bytes (only the recount removes a live request's reservation, when the request outlived the 1 h TTL; upload bodies have a read deadline far below it, below, so this is a backstop); (2) delete the reservation (the bytes move from "reserved" to "rows"). Used by page, figure and source-PDF upload, `writeContent` (HTML, compiled text, translation), `writePageText` (page-version snapshot), split and merge. |
| Release (the write failed) | `releaseReservation`: lowers the counter of the reservation's subject only if the reservation still exists, and deletes it, in one batch; a no-op after a commit or after the recount dropped it. |
| Shrink or replace (rows now account for fewer bytes) | `releaseStatement(db, projectId, ...)` in the swapping batch, conditioned on the new key, from the project's current owner: smaller unversioned content (`writeContent`), the old source PDF on replace. |
| Delete a page, figure, text or project; prune versions | `deleteRowAndRelease(db, projectId, ...)`, `deleteTextObjects`, `deleteProject`, `pruneVersions`: the release statement runs first in the deleting batch, only while the row still exists, computed from the rows themselves (`textBytesSql`, `projectBytesSql`) and applied to the project's current owner, so a replay releases nothing and a transfer in between cannot misdirect it. R2 objects go after the rows (tombstones). |
| Give up an edited full text (`clearCompiled`, `DELETE /texts/:id/compiled`) | No counter change: one batch inserts a `compiled` version naming the current object with its bytes and clears the text's pointer, both only while the pointer and bytes are still what the request read; the bytes move from the text row to the version row. An empty full text has no version; its object is deleted after the swap. Versions are pruned as for a save. |
| Split and merge (`copyIntoNewTexts`) | All or nothing: one batch inserts every new text and page (each insert re-checks the caps), commits the reservation, and ends with a guard that breaks `profiles.storage_bytes >= 0` if any insert wrote nothing, which rolls the whole batch back. No partial copy is ever left for a cleanup an interrupted Worker might not run. Copies get new R2 keys; no object is shared by two rows. |
| Transfer ownership | `POST /transfers/:id/accept`: one batch claims the offer with a nonce and measures, inside the transaction, the project's row bytes **plus its reservations** (`claim_bytes`); moves the owner only with that claim, the offerer still owning it, the accepter still a member and room for `claim_bytes` under the new owner's quota; then credits the new owner and debits the old one by exactly `claim_bytes`, **moves the project's reservations to the new owner**, and swaps the roles, each conditioned on the project carrying the nonce; a failed move releases the claim in the same batch. An upload in flight during the accept therefore commits or releases on the new owner's counter. |
| Delete by an owner (`DELETE /projects/:id`, "delete my data") | The deleting batch re-checks that the caller still owns the project (`ownedBy` guard); otherwise nothing is deleted (`409 owner_changed` on the route). "Delete my data" deletes the profile only once it owns nothing, so no project is ever removed by the profile cascade (which would skip its tombstone and leave its objects). |
| Recount (daily backstop) | `recountStorage` in the retention sweep: deletes expired reservations (left by an interrupted Worker) and sets every counter to rows + remaining reservations in the same batch, so a leak is corrected and an upload in progress keeps its quota. Logged as `_r<n>` in the `retention.sweep` slug. |

Checked by `test/storage-property.test.ts` (seeded random batches of concurrent uploads, edits, deletes, splits, merges, content writes, transfers, recounts and a "delete my data", asserting the invariant, no leftover reservation, and that R2 holds exactly the objects rows name, after every batch), `test/storage-owner.test.ts` (each transfer interleaving held open deterministically) and `test/copy-atomic.test.ts`.

**Read deadline.** An upload holds its reservation while its body arrives, so the body has a deadline in proportion to the declared size (`src/body.ts` `readDeadlineMs`: 30 s of grace plus the size at 32 KiB/s, capped at 20 min; 10 MB gets about 6 min, a 25 MB PDF about 14 min). When it passes, the stream is cancelled, the answer is `408 upload_too_slow` (retryable) and the reservation is released at once. JSON bodies get the same rule for their cap. The cap is at most half the reservation TTL (tested), so a reservation is never dropped by the recount while its body is still being read.

Residual: a request that outlives its reservation for another reason (stalled between the read and the commit for over half an hour) and is committed after the recount is charged without a quota check (bounded by one request's bytes, at most 25 MB). While two Worker versions run side by side across the 06:17 recount (a deploy or rollback at that minute), an upload on the older version (which keeps no reservation) is not counted until the next recount.

## 7. Retention

- Clock: `projects.last_edited_at`, bumped by every content edit (project, text, page, upload, HTML, summary, metadata and comment writes call `touchProject`), which also clears `retention_warned_at`.
- **Visible in-app**: every project response carries `retention: {delete_after, warning, days_remaining}`; the dashboard shows a banner once `warning` is true (30 days before deletion, `RETENTION_WARN_DAYS`). `/session` exposes the policy (`days`, `warn_days`).
- **Cron** (`triggers.crons: ["17 6 * * *"]`, UTC daily): `scheduled()` runs `runRetentionSweep`. The sweep warns every project older than (180 - 30) days: `retention_warned_at` is a compare-and-set on `last_edited_at`, and one in-app notification goes to each owner and editor only if that stamp landed. It deletes only projects older than 180 days that were warned at least 7 days earlier (so a missed cron or an imported project is always warned first), and the deleting transaction re-checks that condition, so an edit that lands after the selection keeps the project and every file (rows are deleted before objects). Bounded to 50 per step per run, then tombstones are re-swept. All times are UTC ISO strings in one format (no milliseconds), so string comparison is time comparison. Cron details verified in the Cloudflare docs: five-field UTC expressions, `scheduled()` handler, `wrangler.jsonc` `triggers.crons`, up to 15 minutes of runtime.
- **Delete my data** `DELETE /api/me/data {"confirm":"delete my data"}`: deletes every project the person owns (rows and a tombstone in one transaction, releasing bytes, then the R2 prefix), then the profile; the `CASCADE`s remove memberships, annotations they wrote anywhere, notifications, preferences, invites they created; version authorship in others' projects becomes `NULL`. Re-runnable if interrupted. The person's next sign-in creates a fresh empty profile. Subrequest budget: roughly 4 R2/D1 calls per project; 100 projects fits well inside 1000.
- Unwarned email: see section 9. **A person who never returns never sees an in-app warning.** That is the main reason to build the email path.

## 8. Models and tasks

Model list comes from the Gateway catalog (`getCatalogSnapshot`, canonical prefix-free IDs), never from app config, filtered by capability and cached ~60 s per isolate (pattern from LanGames `models.ts`). No Bedrock/OpenRouter keys. The Gateway rejects PDF/file parts (`400 file_input_unsupported`), so **every page is sent as an image** (`image_url` with a data URI, like Media Tools `vision.ts`), rasterized in the browser.

| Task | Needs (catalog `capabilities`) | Input | Notes |
|---|---|---|---|
| `ocr` (image to Markdown) | `vision`, `text-generation` | one page image | Default = highest-ranked (`recommended`, then `order`) vision model. Media Tools currently uses `qwen3-vl-235b-a22b-instruct` and `gemma-4-26b-a4b-it`; do not hard-code, read the catalog. |
| `html_page` (PDF page to HTML) | `vision`, `text-generation` | page image + pdf.js text hint | Same default as OCR, with the PDF-to-HTML prompt. Page normalisers: written item numbers in a plain `<ol>` become `start`/`value`; a table label in an extra empty first column becomes a `<caption>`. The reply carries `warnings` (`figure_values`: a figure description states values read off a graph; `numbering_restarted`: a list restarts at 1 though the text layer prints higher numbers), which the editor lists after a conversion. |
| `html_page_math` | `vision` **and** `reasoning` preferred | page image + text hint | The "math/tables" path. See below. |
| `html_cleanup` | none | assembled HTML | Deterministic (the legacy cleanup normalised callout boxes and wrapped `<article>`; no model). Also drops running headers and footers: a first or last block repeated on three or more pages with page numbers in step (`dropRunningHeads`). Output sanitized. |
| `summary`, `translation`, `formula_repair` | `text-generation` | compiled text, one translation chunk (<= 12,000 chars), or the failing TeX strings | Same capability filter as LanGames (the catalog also marks Whisper recommended, so filter on capability, not on `recommended`). |

### Mathematics-heavy PDF-to-HTML (required, retained)

The legacy app used Gemini 3 Flash via OpenRouter for page parsing and a separate "formula repair" pass. Design:

1. **Per-task model choice stored per text** (`text_settings.model` for the default vision task, `text_settings.math_model` for math pages), validated against the live catalog at request time (`model_not_allowed` if it is not offered now).
2. The page picker in the editor gets a per-page (and "apply to rest") toggle **"Math / tables page"**. When on, the request names the `math_model`. The UI lists candidates = catalog models with `vision` + `reasoning` (stronger first, by the Gateway's `order`); if none has both, it lists `vision` models and says so. This capability rule is the fallback; the measured policy below narrows and orders it.
3. Inputs improve accuracy without PDFs: the browser renders the page to a canvas at a larger scale for math pages (up to the Gateway/Doorway body cap; target <= 4 MB image like Media Tools `MAX_IMAGE_BYTES`), and sends the pdf.js text layer as a hint (as the legacy `textHint`).
4. **Output headroom** (handoff notes): for any model whose catalog entry has `reasoning`, `max_tokens = task_budget + 4000`; `enable_thinking: false` and `reasoning_effort: "low"` are sent **only** to reasoning models and only for non-math tasks (a non-reasoning model answered them with `400 capability_unsupported`); math pages leave thinking on. 4,000 headroom made all six reasoning models answer; larger was worse (a model reasoned past a two-minute timeout), so the cap is 4,000 and the per-request deadline is explicit. A reply that stopped on `finish_reason: "length"` is never success: `model_output_empty` when nothing visible was written (reasoning used the budget), `model_output_truncated` when it stopped mid-answer. Math pages get 8,000 tokens of headroom with thinking left on, except for models in `MATH_THINKING_OFF` (measured 2026-11-10; `docs/model-policy.md`).
5. Formulas: the model emits TeX in `\(...\)`/`\[...\]` (or MathML); the Worker sanitizes HTML on write, which **keeps MathML** (the allowlist includes `math`, `mi`, `mo`, `mfrac`, `msup`, `mtable`, ... and strips `annotation-xml`, `maction`, `href` on MathML), and the legacy server-side `temml` conversion for export stays (temml is pure JS; run in the Worker at export). The "formula repair" endpoint becomes a text-model call on the unresolved formulas only (cheap) rather than a second vision pass.
6. Spend guard: one page per request; a math page uses a stronger and costlier model, so the UI shows which model it will use and the Gateway quota before the first math page; nothing runs unattended.

**Defaults (as built, 2026-11-10).** Measured, not guessed: a live run through the real Gateway picked DeepSeek Flash (`deepseek-v4.1-flash-1017`) for OCR, page HTML and text tasks and Magistral Small (`magistral-small-2509`) for math pages. The math menu offers only the three models that passed (Magistral, DeepSeek, Qwen 3.8); Kimi is offered nowhere and Gemma not for math, both still typeable by id. DeepSeek runs with thinking off on the math path too (thinking on, it reasoned through 14,000 tokens on a tables page). The catalog decides what exists; the policy (vars, with built-in fallbacks) only orders and narrows, and a renamed model falls back to the next one, then to the capability rule in point 2. Evidence, overrides and re-verification: `docs/model-policy.md`.

### On-screen mathematics (as legacy rendered it)

Stored form: TeX in `\(...\)` (inline) and `\[...\]` (display), as legacy stored it. The page prompt asks for exactly that, and every live-eval page output used it. MathML in content is still accepted: the sanitizer keeps a MathML subset, the browser renders it natively on screen, and the export passes it through. The export converts TeX to MathML with temml for Manifold, unchanged and checked against the legacy golden.

Screen: KaTeX 0.16.38, the legacy version. Legacy used `katex/contrib/auto-render` on the live editor DOM with delimiters `\[ \]` and `\( \)`, `throwOnError: false` (bad TeX shows in red, error in the tooltip), `trust: true` and `strict: false`, plus `katex.min.css` and the `.pdf-preview-pane` stylesheet (16px Georgia, line height 1.75). The new client (`client/src/lib/math.js`) ports auto-render's delimiter algorithm (`splitAtDelimiters`/`findEndOfMath`, its ignored tags, entity-decoded text) to work on strings. In the parent page it runs on the draft after the Worker's own sanitizer (bundled into the client) and on stored content. The KaTeX markup goes into the `sandbox=""` srcdoc frame together with the legacy pane stylesheet (generated into `client/src/lib/legacy-preview-css.js`) and KaTeX's CSS. Deliberate differences from legacy: `trust: false`, `strict: "ignore"` (what legacy's `false` meant), `maxSize` 20 em, `maxExpand` 1000. Markdown previews also take `$$...$$` and Pandoc-style `$...$`; legacy rendered no maths in Markdown. KaTeX class names in content are dropped by the sanitizer at storage and again before rendering. Style attributes never survive the sanitizer, so stored markup cannot imitate KaTeX output.

Fonts: the frame has an opaque origin and runs no script. A font request from it is cross-origin and carries no cookie, so through Doorway (an authenticated page route) a URL font would get a 401. Making it work would need `Access-Control-Allow-Origin: null`, which any sandboxed document anywhere satisfies, plus a public font route in Doorway. Instead the parent fetches the faces the rendered formulas need (same origin, with the session) from the bundled KaTeX assets, once per page load. It inlines them as `data:font/woff2` URIs in the frame's stylesheet. The frame's CSP is `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:`, and the page CSP already allows `font-src 'self' data:`. Neither CSP allows inline script, and the iframe keeps `sandbox=""`. Faces are chosen from KaTeX's own class-to-font rules, so a page with no maths carries none. The 71-formula fixture needs 7 faces (about 89 KB, 120 KB as base64).

Checks: `client/test/math.test.js` (71 real and legacy-style formulas, safety, faces); the journeys assert KaTeX fonts are loaded and used inside the frame; `client/e2e/katex-compare.spec.mjs` (`npx playwright test -c playwright.compare.config.js`) renders every fixture formula with the legacy setup and with the new preview, and compares glyph layout (pass within 0.25 CSS px) and pixels (reported).

## 8a. Unsaved edits kept in the browser

The tools origin is shared by every CAIL tool, so `localStorage` is readable by any page on it. What the client keeps (`client/src/lib/drafts.js`) is the least that recovers an edit: one draft per text and person, holding the edited text of the one editor last changed (a page's text, the full text, or the HTML), a hash of the saved text it started from (to say whether the saved text changed since) and the time. The key is `manifold-companion:draft:v1:<first 128 bits of SHA-256("manifold-companion:" + subject)>:<text id>`, so no key names a person. A draft is removed on save, on discard, after 7 days, when the app starts for a different person on this browser (the app cannot observe Doorway's sign-out, which happens on Doorway's own page, so a signed-out person's draft goes before anything of the next person renders), from Settings, and by "Delete my data". Drafts never go to the Worker. Leaving with an unsaved edit asks first: an in-app dialog for in-app navigation (the router is a data router for `useBlocker`), the browser's own prompt for closing or reloading the tab. A cleaner end on sign-out would need Doorway to send `Clear-Site-Data: "storage"` on its sign-out response (it would clear every tool's storage on the origin); not done, it is Doorway's call.

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

## 10. Model-call and error mechanics (as built)

`src/gateway.ts`: `createCailClient({app: "manifold-companion", baseUrl: CAIL_API_BASE, fetchImpl: GATEWAY binding})`; the Gateway leg goes in `x-cail-identity-jwt` (the client does this; no Bearer). One attempt, no redirects, no retries. Every outbound call gets a **fresh** request id (only the inbound trace context is carried). Cancellation: `request.signal` (`enable_request_signal` is set; the compatibility date `2026-03-25` predates the 2026-11-17 default) combined with a per-task deadline (`DEADLINES_MS`, capped by `MODEL_DEADLINE_MS`). Errors pass the Gateway's safe code and message through, with `x-should-retry` and `Retry-After`; `quota_exceeded` is never retryable; a transport failure (`network_error`, status 0) is an ambiguous outcome and never retryable; a cancelled request is `499 client_closed_request`, a deadline `504 model_deadline_exceeded`. Tests use `@cuny-ai-lab/cail-client/testing` helpers with only the binding stubbed. Quota fields are `limit` and `estimated_used` in microdollars.

## 11. Route map (as built) and legacy equivalents

Base: legacy `/api/...` becomes `/manifold-companion/api/...`. Every project- or text-scoped route calls `requireRole`/`requireTextRole` once and has a row in `test/authz.test.ts` (the coverage test fails otherwise).

| Area | Worker routes | Legacy | Notes |
|---|---|---|---|
| Session | `GET /session`, `PUT /profile`, `DELETE /me/data` | `/auth/*` | no passwords, registration, approval, reset or local sessions |
| Projects | `GET/POST /projects`, `GET/PUT/DELETE /projects/:id`, `GET /projects/:id/members`, `PUT/DELETE /projects/:id/members/:subject`, `GET/POST/DELETE /projects/:id/transfer` | `projects.js`, `shares.js` | owner removes or changes a member between editor and viewer, member leaves (which ends an offer made to them); the owner offers ownership to one member |
| Transfers | `GET /transfers`, `POST /transfers/:offerId/accept`, `.../decline` | none | only the named member, while still a member, sees or answers an offer; accepting makes the previous owner an editor |
| Invites | `POST/GET /projects/:id/invites`, `DELETE .../invites/:inviteId`, `POST /invites/redeem` | share by email | single use, bound to redeemer, fragment token |
| Texts | `POST/GET /projects/:id/texts`, `PUT .../reorder`, `.../bulk-status`, `.../bulk-delete`, `.../merge`; `GET/PUT/DELETE /texts/:id`, `POST /texts/:id/split` | `texts.js` | |
| Pages | `GET /texts/:id/pages`, `PUT .../pages/reorder`, `POST/DELETE .../pages/:pageId`, `POST /texts/:id/pages` (upload), `GET .../pages/:pageId/image` | upload, page-image | browser resizes; Worker sniffs JPEG/PNG/WebP |
| Content | `GET /texts/:id/result`, `GET/DELETE /texts/:id/compiled`, `POST /texts/:id/save`, `GET/PUT /texts/:id/html` | same (DELETE is new) | HTML sanitized on write; DELETE gives up an image text's edited full text (the export uses the pages again; the full text becomes a version) |
| Files | `PUT/GET /texts/:id/source-pdf`, `POST/GET /texts/:id/figures`, `GET/DELETE .../figures/:figureId` | pdf-upload, image | |
| Metadata, settings | `GET/POST /texts/:id/metadata`, `GET/POST/DELETE /texts/:id/settings` | same | |
| Versions | `GET /texts/:id/versions?type=`, `GET .../versions/:versionId`, `POST .../revert` | same | revert snapshots the current content first (legacy bug fixed) |
| Search | `GET /search?q=` | `/search` | membership-scoped; FTS5 or LIKE |
| Models | `GET /models`, `GET /quota` | `/defaults`, `/projects/usage` | live catalog; Gateway quota passthrough; no ledger |
| Tasks | `POST /texts/:id/pages/:pageId/ocr`, `POST /texts/:id/parse-page`, `POST /texts/:id/html/cleanup`, `GET/PUT/POST /texts/:id/summary`, `POST /texts/:id/translate-chunk`, `GET/PUT /texts/:id/translation`, `POST /texts/:id/formula-repair` | SSE `/ocr`, `/ocr-single`, `/pdf-parse-page`, `/pdf-cleanup`, `/summary`, `/translation`, `/formula-repair` | one unit per request; the browser drives loops |
| Export | `POST /projects/:id/export`, `GET/PUT /projects/:id/export-settings` | `export.js` | streamed ZIP, same structure (section 2, `src/export.ts`) |
| Comments | `GET /texts/:id/mentions`, `GET/POST /texts/:id/annotations`, `GET/PUT/DELETE .../annotations/:annotId`, `POST .../resolve`, `.../unresolve`, `.../replies` | `annotations.js` | legacy roles; legacy bugs fixed (parent text, anchor cap, member-only mentions) |
| Notifications | `GET /notifications`, `/unread-count`, `POST /:id/read`, `/read-all`, `GET/PUT /preferences` | `notifications.js` | in-app only |
| Removed | admin users, usage, backups, user search, token ledger | `admin.js`, `users.js` | Admission and the Gateway own these jobs |

## 12. Doorway mount changes in `cail-tools-admission` (not made; checked against source at `1bf54e0`)

The exact steps, files and tests are in `HANDOFF.md` section 6 (deploy checklist). Findings from the Admission source that settle earlier open questions:

- **Membership is enforced by Doorway for this mount.** Authenticated JWT routes resolve current Admission membership per request (`currentAdmissionExpiry` / `resolveAdmission` in `apps/doorway/src/doorway.ts`); an expired membership is `403 admission_required` before the Worker is called, and the legs' lifetimes are capped by the membership expiry.
- **The `tool` claim enumeration does not need to change for the mount to work.** Doorway passes `tool: route.toolId` when minting the Gateway leg, and `gatewayTool()` in `apps/doorway/src/identity.ts` drops any value not in `GATEWAY_TOOLS` (`agent-studio`, `site-studio`, `media-tools`, `workbench`, mirrored in `config/contract/identity-jwt-claims-v1.json`). PDF Accessibility (mounted 2026-10-28 with `gatewayIdentity`) is not in the set, so its legs carry no `tool`. Manifold Companion's legs would likewise carry none: calls still verify and still spend the person's own budget; the CAIL Client also sends `X-CAIL-App: manifold-companion`. Adding the tool only matters for per-tool attribution in the Gateway's usage breakdown, and it changes a shared identity contract (Stephen Zweibel's stewardship), so it should be its own reviewed change, not part of the mount PR.
- **Pin the routes by name.** `validateGatewayRoute` returns early for any route without `gatewayIdentity` unless the tool is `media-tools`; the guard must also cover `manifold-companion`, or dropping the API route's Gateway leg (or making it public) still parses. With the leg missing, this Worker now answers `401 invalid_credential` (not `authentication_required`), so a policy regression shows as an error instead of a sign-in loop.
- **Doorway removes `content-length`** on forwarded requests and responses (`admissionRequestHeaders`, `productResponseHeaders`); uploads therefore declare `?size=` and the Worker enforces it as a hard read limit. Responses to authenticated routes get `cache-control: private, no-store` and `vary: cookie` from Doorway.

## 13. Verified versus assumed

Verified from Cloudflare docs (docs search, 2026-11-09): D1 limits (2 MB row, 100 KB statement, 100 binds, `db.batch()` is one transaction, 50 MB result size); Workers limits (128 MB memory per isolate, default 30 s CPU raisable to 5 min, 10,000 subrequests on paid); `request.signal` needs `enable_request_signal` before compatibility date 2026-11-17 and `request_signal_passthrough` is separate; Cron Triggers (UTC, `scheduled()`, 15 min). **Not found in the docs:** FTS5 on remote D1 (confirmed by test on 2026-11-10; still created at runtime, section 3).

Verified by running: the Worker suite in workerd via `@cloudflare/vitest-plugin` (real Hono app, real CAIL identity verification with the test issuer, real cail-client, D1 and R2 in Miniflare, only the Gateway binding stubbed); the sanitizer against a spec-compliant parser (parse5 tree construction plus serialize/re-parse rounds), not only HTMLRewriter, which tokenizes and does no tree construction; the export against a golden made by running the unmodified legacy `server/routes/export.js`; fflate and temml under workerd; the client's unit tests; three Playwright journeys against `wrangler dev` (real workerd, local D1/R2) behind a Doorway double minting real test-issuer legs, with a Gateway stub Worker on the service binding and the production CSP, with no CSP violations; `wrangler deploy --dry-run`.

Assumed / not verified: the 2 MB row limit (not enforced locally; enforced by caps in code); real Doorway in front of the Worker; real Gateway calls and model quality (none made); R2 behaviour at 1000-key list/delete pages; HEIC decoding in Safari (Chromium refuses HEIC with the message, tested; `heic2any` was removed after a run under the page CSP showed it needs `new Function`); Worker CPU for the largest allowed export on production hardware (designed for, section 2 and `src/export.ts`, not measured there).

