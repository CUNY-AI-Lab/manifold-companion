# Handoff: Manifold Companion on the CAIL stack

State on 2026-11-10. **Live**: `be19329` deployed by the coordinator (version `6a1805df…`, tag `mc-be19329`) behind the Doorway mount (cail-tools-admission #383, merged), migrations 0001-0007 applied to the real D1, accepted by the owner on 2026-11-10. Later commits are on branch `cail-stack` (pushed, CI green), not yet deployed; they add migrations 0008, 0009 and 0010, all additive. Read `DESIGN.md` for the architecture. This file says what is built, what is not, how to run it, how to deploy it, and what is still open.

## 1. Run it

From `worker/`:

```bash
npm ci
npm run typecheck
npm run check:logging          # fails on any console use or other logging library in src/
npm test                       # Worker suite in workerd (Miniflare D1/R2), 510 tests
npm run build:client           # worker/client: npm ci + vite build -> worker/client/dist
npm run test:client            # client unit tests, 143
npm run test:e2e               # Playwright: wrangler dev + Doorway double + Gateway stub: 11 journeys, axe WCAG 2.2 A/AA on every screen (desktop and phone, light and dark), a keyboard-only walk
npx wrangler deploy --dry-run --outdir .wrangler/dry-run   # needs client/dist
```

`.npmrc` pins the `@cuny-ai-lab` scope to npmjs and sets `legacy-peer-deps`. The e2e harness (`client/e2e/doorway-double.mjs`) applies the migrations to a throwaway local D1, starts `wrangler dev -c wrangler.jsonc -c client/e2e/gateway-stub.jsonc` with the test issuer's JWKS as a var and `--local-upstream` set to the double's origin, and mints real app and Gateway legs per request (cookie `e2e_as=alice|bob|none`). Playwright browsers must be installed (`npx playwright install chromium`).

The legacy Express app (`server/`, `client/`) is untouched on this branch and still serves its old host from `main`.

## 2. Review of the earlier work (phase 1 and the first three phase-2 commits)

Defects found and fixed in `5a0155d` and later commits, each with a test that fails on the old code:

| Severity | Defect | Failure scenario | Fix |
|---|---|---|---|
| High | Retention deleted a project's R2 objects before re-checking eligibility, and `deleteProject` never re-checked | A person edits a 180-day-old project while the cron runs: the files are gone and then the rows | Rows first, in one transaction that re-checks the retention condition, releases bytes and writes a cleanup tombstone; R2 sweep after; cron re-sweeps tombstones |
| Medium | A refused FTS5 migration would block the deploy | Remote D1 rejects `CREATE VIRTUAL TABLE ... fts5` (unconfirmed in docs): `0002` fails, `0003+` never apply | FTS5 objects created at runtime (`ensureSearchIndex`), LIKE fallback; no migration mentions FTS5 (tested) |
| Medium | Verified app leg with no Gateway leg returned `authentication_required` | A Doorway policy regression drops `gatewayIdentity`: every API call navigates to `/launch`, Doorway returns the browser, loop | `401 invalid_credential` (shown, not navigated) |
| Medium | MathML empty elements (`mspace`, `none`, `mprescripts`, ...) emitted as bare start tags | Browsers do not self-close foreign elements without `/>`, so the next siblings became invisible children of `mspace` (formulas lost content) | Always emit an explicit end tag; found while comparing the export golden |
| Low | Retention warning inserted even when its compare-and-set stamp missed; only the owner was warned | A project edited during the sweep gets a spurious warning; an editor keeping a project alive is never told | Notifications inserted only if the stamp landed; owners and editors warned |
| Low | MathML fences dropped (`open` treated as boolean everywhere; `close`/`separators` rejected) | `mfenced open="("` stored as `<mfenced open>` | Fence values kept on MathML; boolean only on `details` |
| Low | One person redeeming two links to the same project at once | Primary-key violation surfaced as `500` | `409 already_member`, losing link unconsumed |
| Low | Network failure from cail-client (`status 0`) mapped to a retryable `502` (draft) | The UI would invite retrying a call that may already have been billed | Non-retryable `network_error` |
| Test | Sanitizer "independent verdict" used HTMLRewriter, which only tokenizes | Tree-construction mutations (foster parenting, namespace switches, serialize/re-parse mXSS) were never checked | parse5 tree construction plus three serialize/re-parse rounds over the whole corpus and fuzz |
| Test | `expect(b).toBeTruthy()` asserted nothing | | replaced with a real isolation assertion |

Reviewed and found sound: identity order (config first -> 503; missing -> 401 `authentication_required`; bad/expired/wrong audience/subject mismatch -> 401 `invalid_credential`; only the Gateway leg forwarded), exact-Origin CSRF before identity, canonical-origin 404, authorization on every route (the matrix covers 65 project/text routes for owner/editor/viewer/stranger, plus a route-coverage test; file serving, figures, versions, invites and exports are all bound to the authorized text or project), quota reservation and every count cap under concurrency (conditional inserts), R2 keys from server UUIDs only, FK cascades, the 2 MB row limit enforced by caps in code (page text 128 KiB, summary 20 KiB, search text 400k chars, annotation anchor 4 KiB, export settings 64 KiB, notifications bounded). The sanitizer withstood the mXSS, namespace, `srcdoc`, `javascript:`/`data:`/entity and protocol-relative cases tried (`test/sanitize.test.ts`), and CPU on 2 MB adversarial inputs stays under 0.3 s. The previous agent's notes claimed a `Co-Authored-By` trailer on its commits; none of the commits carries one.

The uncommitted model-task draft was kept and repaired (type error, conflict handling, distinct length errors, retry semantics, logging), not rewritten.

### 2a. Review of the post-deploy batch (`be19329..04929ac`), 2026-11-10

Independent pass over storage accounting, transfer, role change, split/merge/bulk, comments and notifications, export settings, metadata and migrations 0008/0009. Each fix has a test that fails on the previous code.

| Severity | Defect | Failure scenario | Fix |
|---|---|---|---|
| High | Counter changes named the owner read at authorization; reservations stayed on the old owner across a transfer, and the accept measured rows only | A delete, prune or shrinking write authorized just before an accept releases from the old owner; an upload, split or merge in flight during the accept lands unpaid on the new owner (who may be pushed over quota by bytes they never saw, e.g. a 300-page split started just before) while the old owner keeps the charge | `bd829e4`: owner resolved in SQL (`ownerSql`); reservations carry `project_id` (migration 0010); the accept counts and moves them |
| High | "Delete my data" and `DELETE /projects/:id` deleted by an id list / authorization read before an accept could commit | Alice offers a project to Bob, then deletes her data; Bob accepts in between; Bob's project and files are deleted | `da55a80`: `ownedBy` guard in the deleting batch; profile deleted only once it owns nothing |
| Medium | A write committed after the recount dropped its expired reservation was never charged | A slow upload held open past an hour across 06:17 UTC is stored for free; many at once store a whole quota uncounted | `99e0bf3`: the commit charges the owner when the reservation is gone |
| Medium | Split/merge could commit partially (a racing cap refused some inserts) and cleaned up row by row outside the transaction | An interrupted cleanup leaves texts and pages whose image bytes no counter holds | `3d92f74`: a guard statement rolls the whole batch back |
| Medium | An upload, figure, split, merge, new text or comment whose parent was deleted mid-request answered 500 (foreign key failure) | Uploading into a text a collaborator just deleted shows "Internal server error" | `fb57bb1`: parent-conditional inserts; 404 |
| Low | A transfer offer outlived the named member's membership | A removed member still sees the project's name in their offers; the owner gets `transfer_pending` for anyone else | `d7a762c`: leaving or removal ends the offer; listing and answering need membership |
| Low | Reply notifications went to a thread's author after they left the project | A former member keeps receiving the text's name and each reply | `48c389b`: sent only to current members |

Reviewed and found sound: the transfer batch's nonce discipline (concurrent accepts, accept vs revoke, abandoned claims), one pending offer per project, expiry, owner-only offer/revoke/role routes (authz matrix rows exist), the previous owner becoming an editor, bulk status/delete and merge scoped to the project (ids from another project are ignored or refused), R2 keys never shared between rows after split/merge, range anchors validated (known keys, bounds, page of the same text) and shown only as text, mentions limited to members, export settings and Dublin Core validated and bounded (labels and metadata reach the ZIP only through `escapeYaml`), migrations 0008-0010 additive (new tables, nullable columns, indexes on new tables only, no FTS5). `test/storage-property.test.ts` asserts the storage invariant and the R2 object set after random concurrent batches (16 seeds in the suite, 64 run locally).

## 3. Built (tested)

| Package | Commit | What | Worker tests after |
|---|---|---|---|
| Review fixes | `5a0155d` | section 2 | 308 |
| Gateway client and model tasks | `e76ac4d` | `src/gateway.ts`, `src/models.ts`, tasks: OCR one page, page image to HTML with the separate math model, cleanup, summary, translate one chunk, formula repair; `/models`, `/quota` | 349 |
| Export | `11ddb33` | streamed Manifold ZIP (fflate, temml), golden-compared with the legacy exporter; export settings | 365 |
| Annotations and notifications | `ebdb3e4` | legacy roles, legacy bugs fixed, member-only mentions, in-app notifications and preferences | 386 |
| Logging | `9346e8b` | cail-log catalog, CI gate, leak test | 390 |
| Client | `13abf19` | `worker/client`, unit tests (11), Playwright journeys (3) | 390 |
| Live evaluation harness, KaTeX preview, preview fix | `594f98f`, `fa6a4c4`, `5e91025` | `scripts/live-eval.mjs`; legacy-faithful KaTeX in the sandboxed preview; formula placeholders restored before sanitizing | not recorded |
| Model policy | `726c158` | measured defaults and menus (`docs/model-policy.md`); KaTeX classes dropped at storage; OCR prompt asks for `\(…\)` | 416 |
| Page fidelity | `5c2dd60` | prompt rules, list-number and table-label normalisers, running-head removal, page warnings | 434 |
| Version history | `0ba0466` | history panel, read-only view, restore; version reasons (migration 0007); per-page pruning | 438 |
| Reordering | `9ca3728` | move pages and texts; export follows | 442 |
| Accessibility, help | `3d5959c` | axe WCAG 2.2 A/AA in e2e, contrast and dialog focus fixes, keyboard walk, first-run welcome, Help page | 442 |
| Release runbook, canary | `86026a8`, `68c0d58` | Gateway-binding guard test, readiness probes the catalog through the binding, health route (public at first; now behind sign-in), 15-minute self-check, required secret | 452 |
| **Deployed: `be19329`** | | | |
| Dublin Core metadata | `08e059b` | per-text DC panel (legacy fields, partial-update semantics), project details for owners | 456 |
| Export sections | `a900a57` | nested TOC editor, saved per project by editors, validated server-side | 457 |
| Member roles, transfer | `fe3574a`, `0f14d0d`, `cbaefde` | role change; ownership transfer as an offer the member accepts (migration 0008), nonce-guarded single batch; in-app confirmation dialogs everywhere | 471 |
| Storage reservations | `8af8bf1` | explicit reservations (migration 0009), committed in the row's batch; daily recount to the invariant (DESIGN 6) | 472 |
| Anchored comments, notification menu, split/merge/bulk | `c6a3c6f` | comments on a text range with re-anchoring and detach, edit own, resolved view; header notification menu; split, merge, bulk status and delete UI | 472 |
| Pre-deploy review of the above | `bd829e4`..`ab2b78e` | section 2a | 510 |
| **Deployed: `ddd17dc`** (tag `mc-ddd17dc`, migrations 0001-0010) | | | |
| Upload read deadline | see git log | body reads end at a deadline in proportion to the declared size (DESIGN 6, "Read deadline"); a stalled upload is `408 upload_too_slow` and its reservation is released at once | 516 |
| Drag and drop, HEIC | see git log | files dropped anywhere on a text's page upload (image text: images and PDFs as pages; PDF text: the PDF is chosen for conversion, images become figures; other files named and refused); a file dropped elsewhere never replaces the app. HEIC: `heic2any` removed (verified under the page CSP: its Emscripten glue calls `new Function`, refused by `script-src 'self'`, and the upload hung silently); the browser decodes HEIC itself (Safari) or the person is told how to convert | 516 |
| Text pagination | see git log | the project page lists texts 50 at a time (`?page=`), moves count positions across the whole project, the export dialog loads every text | 517 |
| Per-text settings UI | see git log | “Model settings for this text”: model (and math model for PDF texts), temperature, maximum length, transcription prompt (image texts); the run pickers name the saved model as their default; a viewer reads them | 518 |
| Full-text editor (image texts) | see git log | “Full text”: the page texts as the export joins them; “Edit as one text”, save (the export then uses it), “Use the pages again” (new `DELETE /texts/:id/compiled`: the full text becomes a version, bytes move row to row, in the storage property test), version history of the full text | 521 |

Export limits designed for (one request, 128 MB isolate, default 30 s CPU): entries are written one at a time with stream backpressure; figures stream from R2 into stored entries; text is deflated in 64 KiB pushes. Budget checked from D1 sizes before the first byte: 64 MiB of text (allowing 2x for MathML), 256 MiB of figures, 1000 TOC nodes, depth 10, 2000 entries; over it is a clean `413 export_too_large`. Peak memory is about one HTML body (<= 5 MiB stored) plus its MathML and the deflate window. Not measured on production hardware.

## 4. Not built, stubbed, or different from legacy

Not built yet (owner's list of 2026-11-10, in order): moving texts between projects (bulk "move"; needs R2 copies, a storage move between owners and tombstones); drag-and-drop upload, keyboard shortcuts, unsaved-draft protection with local recovery, pagination beyond 50 texts, HEIC verification under the page CSP; client-side figure extraction from PDFs; the rich-text editor. See the end of this file for the plan.

Replaced or reduced:
- Rich HTML editing (contenteditable with KaTeX, find and replace, colours) is replaced by an HTML source editor next to a sandboxed preview. Deliberate for safety; a richer editor must still never render stored HTML in the app origin.
- **Figure extraction from PDFs** (`pdftohtml -xml` on the server) is gone. Figures are added by hand ("Add a figure image") and referenced by file name; the model prompt supports a figure list but the client does not send one. Automatic extraction would need pdf.js operator-list image extraction or crops of the rendered canvas.
- Native-PDF model input is gone (the Gateway rejects PDF parts): pages are rasterised with pdf.js in the browser; the text layer goes along as a hint.
- No server-side bulk OCR or SSE: the browser drives one page per request with Cancel.
- Email notifications, the OCR-complete notification, admin users and usage, backups, token ledger and allowances, usage breakdown, password and account flows: removed by decision.
- The About page is replaced by a short Help page (`/help`) and a first-run welcome on the dashboard.

Unverified client risks: very large PDFs (each page is rendered and held as one JPEG at a time).

## 5. Infrastructure (provisioned and live)

Provisioned 2026-11-10 in the CUNY AI Lab account: D1 `cail-manifold-companion` (`67481a76-aaf2-4035-b261-04e37d099246`, in `wrangler.jsonc`; `test/config.test.ts` fails if a placeholder comes back) and R2 `cail-manifold-companion-files`. The migration rehearsal on a scratch remote D1 passed (0001-0007, 15 tables plus `d1_migrations`, matching the snapshot), and FTS5 works on remote D1. Done by the coordinator on 2026-11-10: migrations 0001-0007 applied to the real D1, the JWKS secret set, `be19329` deployed with tag `mc-be19329`, the self-check cron ran clean, the Doorway mount (cail-tools-admission #383) merged, anonymous `/manifold-companion/api/session` returns 401 with `/launch/manifold-companion`. Before deploying a later commit, apply its new migrations first (0008, 0009, 0010: all additive, so the running version keeps working against the newer schema and a rollback stays safe).

## 6. Release runbook (in order; receiver first)

Every command runs from `worker/` on a machine logged in to Cloudflare (`npx wrangler login`). Nothing here needs a provider key or any secret except Doorway's public JWKS. Steps 6.1 to 6.3 change nothing anyone can reach: the Worker has no route and no `workers.dev` URL until Doorway mounts it (6.5).

### 6.0 Gate (every release)

```bash
cd worker
npm ci
npm run typecheck && npm run check:logging && npm test       # Worker suite in workerd
npm run build:client && npm run test:client                  # client build and unit tests
npm run test:e2e                                             # journeys, axe WCAG A/AA, keyboard walk (npx playwright install chromium once)
npx wrangler deploy --dry-run --outdir .wrangler/dry-run     # bundle and bindings check, no upload
git status --short                                           # clean: deploy only committed code
```

The dry run bundles but never starts workerd; the e2e run does (it is what catches, for example, a non-handler export from `src/index.ts`, which makes workerd refuse to start; `test/platform.test.ts` now guards that too). Its `Missing required secrets: CAIL_IDENTITY_JWKS` warning is expected: the harness passes the test JWKS as a var.

### 6.1 Provision (once)

```bash
npx wrangler whoami                                          # must list account 452c33847cf5cb1e46f391fca32fd1b5
npx wrangler d1 create cail-manifold-companion               # done 2026-11-10; the id is committed in wrangler.jsonc
npx wrangler r2 bucket create cail-manifold-companion-files  # done 2026-11-10
npx wrangler r2 bucket lifecycle add --help                  # optional: a rule aborting incomplete multipart uploads after 1 day (the Worker uses none today)
```

Rehearse the migrations on a throwaway remote database first (remote D1 can differ from the local SQLite the tests use; done 2026-11-10, passed):

```bash
npx wrangler d1 create cail-manifold-companion-scratch       # prints its database_id
#   paste it into wrangler.scratch-d1.jsonc (do not commit the id)
npx wrangler d1 migrations apply SCRATCH_DB --remote -c wrangler.scratch-d1.jsonc
npx wrangler d1 execute SCRATCH_DB --remote -c wrangler.scratch-d1.jsonc --command "SELECT name FROM d1_migrations ORDER BY id"
#   expect 0001_init.sql .. 0007_version_reason.sql
npx wrangler d1 execute SCRATCH_DB --remote -c wrangler.scratch-d1.jsonc --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
#   expect the 15 tables of test/schema.snapshot.json, plus d1_migrations (FTS5 tables appear only after the first search; FTS5 itself is confirmed on remote D1)
npx wrangler d1 delete cail-manifold-companion-scratch
git checkout wrangler.scratch-d1.jsonc
```

Then the real database:

```bash
npx wrangler d1 migrations apply cail-manifold-companion --remote
npx wrangler d1 migrations list cail-manifold-companion --remote     # expect "No migrations to apply"
```

The cron triggers (`17 6 * * *` retention sweep; `*/15 * * * *` readiness self-check) are part of `wrangler.jsonc` and deploy with the Worker; nothing to provision.

### 6.2 First deploy, with the JWKS

`CAIL_IDENTITY_JWKS` is the only secret (Doorway's public signing keys, as JSON text; get the current document from the Doorway owner). `wrangler.jsonc` declares it in `secrets.required`, so a deploy without it fails. Upload it with the code, so the first version already has it and carries a tag (readiness requires both):

```bash
#   write the JWKS as a JSON string value: {"CAIL_IDENTITY_JWKS": "{\"keys\":[...]}"}
node -e 'const fs=require("fs"); fs.writeFileSync(".secrets.json", JSON.stringify({ CAIL_IDENTITY_JWKS: fs.readFileSync(process.argv[1], "utf8").trim() }))' doorway-jwks.json
npm run build:client
TAG="mc-$(git rev-parse --short HEAD)"
npx wrangler deploy --secrets-file .secrets.json --tag "$TAG" --message "Manifold Companion first deploy"
rm .secrets.json
npx wrangler deployments status                              # the new version id, 100%, tag $TAG
```

Later deploys: `npx wrangler deploy --tag "mc-$(git rev-parse --short HEAD)" --message "<what changed>"` (secrets persist). Rotate the JWKS with `--secrets-file` on a deploy, not `wrangler secret put`: that creates an untagged version, and readiness reports `not_ready` until the next tagged deploy.

### 6.3 Readiness read-back (before Doorway, and after every deploy)

Readiness is `ok` only when the configuration is valid, both identity verifiers load, D1 has the schema, the Gateway's public catalog answers **through the GATEWAY service binding** with at least one usable model (no credential involved), and the version has an id and a tag. Three ways to read it:

1. Any time, with no credential: the `*/15` cron runs the same check and logs `readiness.failed` (warn, error codes only) when it fails. In the dashboard: Workers & Pages > cail-manifold-companion > Logs, filter `event = readiness.failed` for the 30 minutes after a deploy: expect none. The daily sweep also logs `readiness.checked` with the verdict.
2. After the mount, signed in: open `https://tools.ailab.gc.cuny.edu/manifold-companion/api/health` in the browser session (it is behind sign-in like every route of this person-funded mount; Doorway publishes no public route for it). `{"ok":true,"status":"ready","version":"..."}`; a 503 `{"ok":false}` means a check failed, and the codes are in Workers Logs (`readiness.failed`) and in the RPC result. The binding-only `/health/live` and `/health/ready` are outside the mount, so Doorway never forwards them.
3. Over RPC from a Worker that binds the service (Doorway, or a release probe): `ManifoldCompanionReadiness.getReadiness()` returns the verdict with error codes.

Why the Gateway check matters: a Worker that reaches the Gateway by its public URL from the same zone gets the zone origin's 404, which no local test shows (the Bibliography Converter's production bug). This Worker sends every Gateway call (catalog, quota, chat) through the binding (`src/gateway.ts`); `test/gateway-binding.test.ts` makes global `fetch` fail and checks every route and the readiness probe still work, and scans `src/` for any `fetch(` that is not a binding's.

FTS5 is confirmed on remote D1 (2026-11-10: `CREATE VIRTUAL TABLE ... USING fts5` and `MATCH` worked on the scratch database). The index is created at runtime on the first search; after it, `npx wrangler d1 execute cail-manifold-companion --remote --command "SELECT name FROM sqlite_master WHERE name = 'text_fts'"` shows it. The LIKE fallback stays for a damaged index.

### 6.4 Rollback

Code (immediate, no data change):

```bash
npx wrangler deployments list                                # find the last good version id
npx wrangler rollback <VERSION_ID> --message "rollback: <reason>"
npx wrangler deployments status
```

Migrations are additive (0007 adds a nullable column and an index; 0008 and 0009 add tables and a nullable column; 0010 a nullable column and an index), so an older version runs against the newer schema; roll the code back first. After rolling back past 0009, an interrupted upload's reservation stays on its owner's counter until a version with the daily recount runs again (the older version has none). If a migration itself damaged data, D1 Time Travel restores the whole database to a point in time (it discards every write after it, so tell users):

```bash
npx wrangler d1 time-travel info cail-manifold-companion     # note the bookmark BEFORE applying a migration
npx wrangler d1 time-travel restore cail-manifold-companion --bookmark=<BOOKMARK>
```

R2 objects are never rewritten in place (new keys per revision), so a D1 restore leaves at most orphan objects, which the retention sweep's cleanup removes with their project.

To take the tool offline without a deploy, revert the Doorway mount (6.5) or remove its route: the Worker has no other way in.

### 6.5 Doorway mount in `cail-tools-admission` (draft PR #383)

The mount is draft PR #383, mergeable once this Worker is deployed and ready (6.2-6.3). What it adds, and what this Worker relies on:

1. A `MANIFOLD_COMPANION` service binding to `cail-manifold-companion`, in the Doorway config and in the release script's exact binding list.
2. Two routes, both authenticated, no public route:
   - `manifold-companion-api`, prefix `/manifold-companion/api`, `requestKind: "api"`, JWT identity, audience `cail:manifold-companion`, **with the Gateway leg** (`gatewayIdentity: true`), held to an exact contract in `policy.ts` so dropping the Gateway leg or making it public fails validation;
   - `manifold-companion-page`, prefix `/manifold-companion`, `requestKind: "page"`, the **app leg only**.
3. The original path, including `/manifold-companion`, is forwarded; the mount-path pin already exists on Doorway main.
4. Release probes: the binding check, the page route, and `probe_mounted_auth` on `/manifold-companion/api/session` (anonymous 401 with `/launch/manifold-companion`) plus the forged-header variant. There is no public health probe; readiness is the RPC and the cron self-check (6.3).

How Doorway treats this Worker's traffic (from the mount's author; the Worker is built for it):
- Request `content-length` is forwarded; on responses Doorway strips `content-length` and `content-encoding`. The Worker never trusts a declared length: uploads declare `?size=` and every body is read with a hard byte limit (`src/body.ts`).
- Doorway sets no request-body cap of its own; a 25 MiB pass-through is tested on its side. This Worker's caps: 10 MB per file, 25 MB per PDF, page-image JSON under 6 MB.
- Every signed-in response gets `cache-control: private, no-store`, so the browser never caches the bundle or the KaTeX fonts. The client inlines each font once per page load from memory (`client/src/lib/katex-assets.js`, tested).
- Every `x-cail-*` response header is stripped. The client reads nothing from them; the support reference shown to people is the `requestId` in the error body.
- The page route carries the app leg only. The Worker's page and asset handler reads no identity and passes the asset binding only `accept`, `accept-encoding`, `if-none-match`, `if-modified-since` and `range` (tested); the session and every Gateway call are under `/api`, which requires both legs.

**`tool` enumeration: not required.** Doorway drops a `tool` not in `GATEWAY_TOOLS`, so the Gateway leg verifies and spends the person's budget without it; the CAIL Client still sends `X-CAIL-App: manifold-companion`. Adding it only adds per-tool attribution in the Gateway usage breakdown and changes a shared identity contract, so it is a separate proposal to Stephen Zweibel.

Admission membership needs no change: Doorway checks it per request for authenticated JWT routes.

### 6.6 Acceptance run (after the mount is released)

0. Readiness: signed in, `/manifold-companion/api/health` is `{"ok":true,...}` (6.3); anonymous, it is 401 like every API route; Workers Logs show no `readiness.failed`.
1. Anonymous `GET /manifold-companion/api/session` -> `401 authentication_required` with `/launch/manifold-companion`; forged `x-cail-*` headers refused; `workers.dev` 404; `/manifold-companion/` without sign-in starts CUNY Login.
2. Signed in: dashboard loads with no CSP violations in the console; set a name; create an image project and a PDF-to-HTML project.
3. Upload a phone photo and a PDF; OCR one page with the default model; check the allowance moves on `/usage` (the in-app estimate is delayed).
4. Convert a two-page PDF with one math page; confirm the math model was used, MathML renders in the preview and in the export.
5. Invite a second person as editor; they redeem; they edit; the owner's storage counts their upload.
6. Export the image project; the ZIP has `manifest.yml` and one file per text.
7. Let the session expire (or clear the Doorway cookie) and click: exactly one navigation to `/launch/manifold-companion`.
8. Next day: cron history shows a run; `retention.sweep` appears in Workers Logs with counts and no failures.

### 6.7 Live model evaluation (owner, with a personal key)

`scripts/live-eval.mjs` runs every model task through the real Gateway with the Worker's own code (`src/task-specs.ts` builders and parsers, `runChat`, the catalog menus, reasoning headroom and switches, deadlines, the sanitizer, the client's preview renderer), on pages of the precalculus textbook (Chapter 7 identities; Chapter 1 tables and piecewise graphs). The key is read once from stdin and only ever sent as `Authorization: Bearer` (cail-client, `kind: "key"`); it is refused as an argument, never read from the environment, never printed, and no file containing it can be written.

```bash
node worker/scripts/live-eval.mjs --dry-run          # the plan, from the public catalog; no key, no spend
pbpaste | node worker/scripts/live-eval.mjs          # the run (default budget $1.50, worst case per call)
node worker/scripts/live-eval-selftest.mjs           # the run path against a stubbed Gateway (no network, no spend)
```

Flags: `--tasks ocr,html,math,summary,translate,repair`, `--models`, `--pages`, `--budget-microdollars` (default 1500000), `--budget-mode worst|expected`, `--out`, `--mathbook`. Output (default the scratchpad `eval-out/`, never committed): `report.md`, `report.json`, `index.html` (page image next to each model's rendered output), and per call `raw.txt`, the parsed output, `preview.html` and `meta.json`. The math comparison runs last, so a budget stop never starves the cheaper tasks. Page images are made with `pdftoppm` at the client's scales (144 dpi; 216 dpi for math pages; JPEG quality 88; at most 3.5 MiB) and text-layer hints with `pdftotext`, the nearest local equivalent of what pdf.js gives the browser.

### 6.8 After the live-eval run (done)

- `src/sanitize/html.ts` drops KaTeX class names at storage (the same list the client uses before rendering; `isKatexClass`). Styles were already stripped.
- The OCR prompt asks for TeX in `\(...\)` / `\[...\]` and never `$`; 6 of 12 OCR outputs in the run used `$...$`. The Markdown preview still accepts `$$...$$` and Pandoc-style `$...$` for older text. The export writes Markdown as stored; whether Manifold renders either form in Markdown is untested.
- `scripts/live-eval.mjs` previews use the KaTeX stylesheet with its fonts as `data:` URIs, like the app; `--rerender` rebuilds a finished run's previews without network.
- Model defaults and menus are now a policy from the run's evidence: `docs/model-policy.md`. A second math run with the policy in force passed 6/6 for both Magistral and DeepSeek (thinking off); Magistral stays the default on fidelity.

## 7. Open questions for the owner

1. **FTS5 on remote D1.** Confirmed 2026-11-10 on a scratch remote D1 (create and `MATCH` worked). Closed.
2. **Math model default.** Settled 2026-11-10 from the live run: Magistral Small for math pages, DeepSeek Flash elsewhere (`docs/model-policy.md`).
3. **Retention by editors.** Edits and comments by any editor keep a project alive and editors get the warning too. Confirm that is the intent for projects whose owner has left.
4. **Viewer export.** Kept from legacy (viewers can export); only editors and owners save export settings.
5. **Email.** In-app only at launch. The retention warning reaches only people who sign in; the Admission-owned notice capability (DESIGN section 9) remains a design.
6. **Gateway `tool` attribution** (6.2): leave unattributed for launch, or ask Stephen for the enum change?
7. **Doorway body size.** Closed: Doorway sets no body cap of its own and its tests pass a 25 MiB body through; this Worker's caps (10 MB files, 25 MB PDFs, page-image JSON under 6 MB) are the limits.
8. **Missing UI** (section 4): version history and reordering are built; split/merge, metadata editing, TOC nesting and a rich editor are follow-ups. Confirm none is needed for the first release.
9. **Public canary route.** Not granted: `/manifold-companion/api/health` stays behind sign-in (a public route would publish the version id and tie Doorway releases to this tool's health). Readiness signals are the RPC and the 15-minute self-check (6.3).

## 8. Rules for whoever continues

- Every route calls `requireRole`/`requireTextRole` once and gets an authz-matrix row; never read a subject from a request body or header other than through `authenticate`.
- No hidden retry, no server-side bulk model loop, no provider key, no spend ledger, no lookup of people by email or name.
- Stored HTML passes `sanitizeHtml` and is shown only in the sandboxed preview; never in the app origin.
- Logging goes through `src/logging.ts` only (`npm run check:logging`); never log prompts, files, names, subjects, tokens or exception messages.
- Never edit an applied migration; add a new one and regenerate `test/schema.snapshot.json` deliberately (empty it to `{}`, run the migrations test, review the printed snapshot). No migration may mention FTS5.
- Deletion is rows first with a tombstone, then R2.
- No AI attribution in commits, code or docs (repository `CLAUDE.md`).

## 9. Remaining work from the owner's list of 2026-11-10

Done on `cail-stack` (see section 3): Dublin Core metadata, export sections, member roles and consented ownership transfer, in-app confirmation dialogs, anchored comments with the notification menu, split/merge/bulk status and delete. Not done yet, in the agreed order, with the design each needs:

1. **Bulk "move" of texts to another project.** Copy R2 objects under the target project's prefix (keys embed the project id), reserve the bytes on the target owner (a storage reservation committed in the batch that re-parents the rows), release them from the source owner in the same batch, tombstone the source prefix; both projects must be the caller's with editor rights. Not started.
2. **Smaller legacy items** (owner's item 8): per-text saved settings UI (`/texts/:id/settings` exists), the compiled-text editor for image texts (`POST /texts/:id/save` exists; the export already prefers it), drag-and-drop upload, keyboard shortcuts, unsaved-draft protection (beforeunload plus a local draft of the current text only, cleared on save), pagination beyond 50 texts, HEIC under the page CSP (verify `heic2any` needs no eval; otherwise reject HEIC with a clear message). Not started.
3. **Figure extraction** (item 7): client-side with pdf.js (operator-list images for embedded rasters; crop of the rendered page for vector figures), user-confirmed crop, upload through the figure route (reserved quota), attach to `<figure class="needs-image">` placeholders. Not started.
4. **Rich-text editor** (item 6): schema-based (ProseMirror or Tiptap) over sanitized HTML, math as atom nodes holding TeX, round-trip tests on the eval outputs and legacy samples, source view kept as a toggle, CSP unchanged unless inline styles are unavoidable. Not started.
