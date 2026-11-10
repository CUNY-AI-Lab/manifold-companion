# Handoff: Manifold Companion on the CAIL stack

State on 2026-11-10, branch `cail-stack` (local commits only; nothing pushed or deployed). Read `DESIGN.md` for the architecture. This file says what is built, what is not, how to run it, how to deploy it, and what is still open.

## 1. Run it

From `worker/`:

```bash
npm ci
npm run typecheck
npm run check:logging          # fails on any console use or other logging library in src/
npm test                       # Worker suite in workerd (Miniflare D1/R2), 452 tests
npm run build:client           # worker/client: npm ci + vite build -> worker/client/dist
npm run test:client            # client unit tests, 132
npm run test:e2e               # Playwright: wrangler dev + Doorway double + Gateway stub: 5 journeys, axe WCAG 2.2 A/AA on every screen (desktop and phone, light and dark), a keyboard-only walk
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
| Release runbook, canary | this commit | Gateway-binding guard test, readiness probes the catalog through the binding, public canary route, 15-minute self-check, required secret | 452 |

Export limits designed for (one request, 128 MB isolate, default 30 s CPU): entries are written one at a time with stream backpressure; figures stream from R2 into stored entries; text is deflated in 64 KiB pushes. Budget checked from D1 sizes before the first byte: 64 MiB of text (allowing 2x for MathML), 256 MiB of figures, 1000 TOC nodes, depth 10, 2000 entries; over it is a clean `413 export_too_large`. Peak memory is about one HTML body (<= 5 MiB stored) plus its MathML and the deflate window. Not measured on production hardware.

## 4. Not built, stubbed, or different from legacy

API complete, no UI yet in `worker/client` (the legacy UI had these):
- split and merge; bulk status/delete; Dublin Core metadata editing; per-text saved settings (prompt, temperature, max tokens; models are chosen per run instead); the compiled full-text editor for image texts (`POST /save`); export TOC sections and nesting (the panel exports a flat list); comment anchoring to text ranges, editing a comment, and viewing resolved comments; notification dropdown (a page instead); member role change (no API either: remove and re-invite).

Replaced or reduced:
- Rich HTML editing (contenteditable with KaTeX, find and replace, colours) is replaced by an HTML source editor next to a sandboxed preview. Deliberate for safety; a richer editor must still never render stored HTML in the app origin.
- **Figure extraction from PDFs** (`pdftohtml -xml` on the server) is gone. Figures are added by hand ("Add a figure image") and referenced by file name; the model prompt supports a figure list but the client does not send one. Automatic extraction would need pdf.js operator-list image extraction or crops of the rendered canvas.
- Native-PDF model input is gone (the Gateway rejects PDF parts): pages are rasterised with pdf.js in the browser; the text layer goes along as a hint.
- No server-side bulk OCR or SSE: the browser drives one page per request with Cancel.
- Email notifications, the OCR-complete notification, admin users and usage, backups, token ledger and allowances, usage breakdown, password and account flows: removed by decision.
- Keyboard shortcuts, autosaved drafts, drag-and-drop and pagination beyond 50 texts per project: not carried over. The About page is replaced by a short Help page (`/help`) and a first-run welcome on the dashboard.

Unverified client risks: `heic2any` under `script-src 'self'` (no HEIC fixture was run; if it needs eval, HEIC uploads fail with an error and other formats are unaffected); very large PDFs (each page is rendered and held as one JPEG at a time).

## 5. Infrastructure that does not exist yet (section 6 creates it)

D1 database (id in `wrangler.jsonc` is `REPLACE_WITH_D1_DATABASE_ID`), R2 bucket, the `CAIL_IDENTITY_JWKS` secret, the Doorway mount. Nothing has been deployed.

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
npx wrangler d1 create cail-manifold-companion               # prints database_id
#   edit wrangler.jsonc: d1_databases[0].database_id = <that id>; commit it
npx wrangler r2 bucket create cail-manifold-companion-files
npx wrangler r2 bucket lifecycle add --help                  # optional: a rule aborting incomplete multipart uploads after 1 day (the Worker uses none today)
```

Rehearse the migrations on a throwaway remote database first (remote D1 can differ from the local SQLite the tests use):

```bash
npx wrangler d1 create cail-manifold-companion-scratch       # prints its database_id
#   paste it into wrangler.scratch-d1.jsonc (do not commit the id)
npx wrangler d1 migrations apply SCRATCH_DB --remote -c wrangler.scratch-d1.jsonc
npx wrangler d1 execute SCRATCH_DB --remote -c wrangler.scratch-d1.jsonc --command "SELECT name FROM d1_migrations ORDER BY id"
#   expect 0001_init.sql .. 0007_version_reason.sql
npx wrangler d1 execute SCRATCH_DB --remote -c wrangler.scratch-d1.jsonc --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
#   expect the 15 tables of test/schema.snapshot.json, plus d1_migrations (FTS5 tables appear only after the first search)
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

1. Before the mount: the `*/15` cron runs the same check and logs `readiness.failed` (warn, error codes only) when it fails. In the dashboard: Workers & Pages > cail-manifold-companion > Logs, filter `event = readiness.failed` for the 30 minutes after a deploy: expect none. The daily sweep also logs `readiness.checked` with the verdict.
2. After the mount, from anywhere, with no credential (the public canary route in 6.5, step 5):
   ```bash
   curl -fsS https://tools.ailab.gc.cuny.edu/manifold-companion/api/health     # {"ok":true,"status":"ready",...}
   ```
   A 503 `{"ok":false}` means a check failed; the codes are in Workers Logs (`readiness.failed`) and in the RPC result.
3. Over RPC from a Worker that binds the service (Doorway, or a release probe): `ManifoldCompanionReadiness.getReadiness()` returns the verdict with error codes.

Why the Gateway check matters: a Worker that reaches the Gateway by its public URL from the same zone gets the zone origin's 404, which no local test shows (the Bibliography Converter's production bug). This Worker sends every Gateway call (catalog, quota, chat) through the binding (`src/gateway.ts`); `test/gateway-binding.test.ts` makes global `fetch` fail and checks every route and the readiness probe still work, and scans `src/` for any `fetch(` that is not a binding's.

After the first authenticated search, check whether FTS5 was created on the remote D1 (`npx wrangler d1 execute cail-manifold-companion --remote --command "SELECT name FROM sqlite_master WHERE name = 'text_fts'"`); if not, search uses the LIKE fallback and nothing else changes.

### 6.4 Rollback

Code (immediate, no data change):

```bash
npx wrangler deployments list                                # find the last good version id
npx wrangler rollback <VERSION_ID> --message "rollback: <reason>"
npx wrangler deployments status
```

Migrations are additive (0007 adds a nullable column and an index), so an older version runs against the newer schema; roll the code back first. If a migration itself damaged data, D1 Time Travel restores the whole database to a point in time (it discards every write after it, so tell users):

```bash
npx wrangler d1 time-travel info cail-manifold-companion     # note the bookmark BEFORE applying a migration
npx wrangler d1 time-travel restore cail-manifold-companion --bookmark=<BOOKMARK>
```

R2 objects are never rewritten in place (new keys per revision), so a D1 restore leaves at most orphan objects, which the retention sweep's cleanup removes with their project.

To take the tool offline without a deploy, revert the Doorway mount (6.5) or remove its route: the Worker has no other way in.

### 6.5 Doorway mount in `cail-tools-admission` (draft PR, mutation tests first)

Checked against `1bf54e0` (origin/main as last fetched, 2026-11-09; re-read 2026-11-10, anchors unchanged); PDF Accessibility (`pdf-accessibility-*`) is the closest precedent. The local checkout of `cail-tools-admission` is on an older branch; branch the PR from origin/main.

1. `apps/doorway/wrangler.toml`: `[[services]] binding = "MANIFOLD_COMPANION"`, `service = "cail-manifold-companion"`.
2. `apps/doorway/src/config.ts`: `MANIFOLD_COMPANION?: ServiceFetcher` in the env interface, `manifoldCompanion: ServiceFetcher` in `DoorwayConfig`, `manifoldCompanion: requiredService(env.MANIFOLD_COMPANION, "MANIFOLD_COMPANION")`.
3. `apps/doorway/src/policy.ts`: add both routes to `GATEWAY_ROUTE_CONTRACTS` exactly as in item 5 (the page entry without `gatewayIdentity`), and extend the `validateGatewayRoute` guard so it also runs for `toolId === "manifold-companion"`; otherwise a policy that drops the API route's Gateway leg, or makes it public, still validates.
4. `apps/doorway/src/doorway.ts`: `const MANIFOLD_COMPANION_ROUTES = new Set(["manifold-companion-health", "manifold-companion-page", "manifold-companion-api"])`, add `"manifoldCompanion"` to `MountOwningService` and one row to `MOUNT_OWNING_SERVICES` (no new `if` in `boundServiceTarget`). The original path, including `/manifold-companion`, is forwarded, which is what the Worker expects.
5. `apps/doorway/config/route-policy.json`: in `tools[]` `{"id": "manifold-companion", "label": "Manifold Companion", "steward": "CUNY AI Lab", "landingPath": "/manifold-companion/", "listed": true}`; in `routes[]`:
   ```json
   { "name": "manifold-companion-health", "match": "exact", "path": "/manifold-companion/api/health", "access": "public", "requestKind": "api", "identityMode": "none" },
   { "name": "manifold-companion-api", "match": "prefix", "path": "/manifold-companion/api", "access": "authenticated", "requestKind": "api", "identityMode": "jwt", "toolId": "manifold-companion", "audience": "cail:manifold-companion", "gatewayIdentity": true },
   { "name": "manifold-companion-page", "match": "prefix", "path": "/manifold-companion", "access": "authenticated", "requestKind": "page", "identityMode": "jwt", "toolId": "manifold-companion", "audience": "cail:manifold-companion" }
   ```
   The health route is the credential-free canary (6.3): exact match, listed before the API prefix, no `toolId` and no identity, like the public Library Assistant routes. It answers only `{ ok, status, version }`, cached for 30 s per isolate, and touches no person's data; the Doorway owner must agree to a public route. Without it, use the Workers Logs check in 6.3.
6. `scripts/release/doorway.sh`: `check_service MANIFOLD_COMPANION cail-manifold-companion ""`, add `"MANIFOLD_COMPANION"` to the exact binding list, add `/manifold-companion/` to the page-route loop, and probes `probe_mounted_auth "$origin/manifold-companion/api/session" '/launch/manifold-companion'` plus the forged-header variant; and the canary `curl -fsS "$origin/manifold-companion/api/health" | jq -e '.ok == true'` (it fails the release when the Worker's GATEWAY binding, D1, identity configuration or version tag is wrong).
7. Tests: `apps/doorway/vitest.config.ts` (`MANIFOLD_COMPANION: "ManifoldCompanionDouble"`), `test/runtime/products.ts` (a `ManifoldCompanionDouble` WorkerEntrypoint, product `"manifold-companion"`), `test/doorway-env.ts`, `test/admission-config.test.ts` and `test/runtime/configuration.test.ts` (binding lists), `test/decision.test.ts` (`/manifold-companion/api`, `/manifold-companion/api/projects`, `/manifold-companion`, `/manifold-companion/`, `/manifold-companionx` denied), `test/runtime/identity-legs.test.ts` (both legs on the API route, app leg only on the page route, header and cookie stripping, forged identity refused, missing binding fails config), `test/integration/release-components.test.ts` (binding list and the anonymous `401` fixture with `launch: "/launch/manifold-companion"`), `test/browser/welcome.spec.ts` (portal card). Mutation tests first: removing `gatewayIdentity` from the API route, or making either route public, must fail `policy.ts` validation.
8. Docs: a "Manifold Companion mount" section in `docs/workflows/README.md` in the PDF Accessibility format, and the product lists in `apps/doorway/README.md` / `AGENTS.md`.

**`tool` enumeration: not required.** Doorway drops a `tool` not in `GATEWAY_TOOLS` (`apps/doorway/src/identity.ts`), so the Gateway leg verifies and spends the person's budget without it, as PDF Accessibility's does today; the CAIL Client still sends `X-CAIL-App: manifold-companion`. Adding `"manifold-companion"` to `GATEWAY_TOOLS` and to the `tool` enum in `config/contract/identity-jwt-claims-v1.json` only adds per-tool attribution in the Gateway usage breakdown; it changes a shared identity contract, so propose it separately to Stephen Zweibel.

Admission membership needs no change: Doorway checks it per request for authenticated JWT routes (`currentAdmissionExpiry`).

### 6.6 Acceptance run (after the mount is released)

0. Canary: `curl -fsS https://tools.ailab.gc.cuny.edu/manifold-companion/api/health` is `{"ok":true,...}` (6.3), and Workers Logs show no `readiness.failed`.
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

1. **FTS5 on remote D1.** Unconfirmed in the docs; the app works either way (LIKE fallback). Worth one look after the first deploy (6.1).
2. **Math model default.** Settled 2026-11-10 from the live run: Magistral Small for math pages, DeepSeek Flash elsewhere (`docs/model-policy.md`).
3. **Retention by editors.** Edits and comments by any editor keep a project alive and editors get the warning too. Confirm that is the intent for projects whose owner has left.
4. **Viewer export.** Kept from legacy (viewers can export); only editors and owners save export settings.
5. **Email.** In-app only at launch. The retention warning reaches only people who sign in; the Admission-owned notice capability (DESIGN section 9) remains a design.
6. **Gateway `tool` attribution** (6.2): leave unattributed for launch, or ask Stephen for the enum change?
7. **Doorway body size.** No Doorway-specific request-body cap was found in source beyond the edge limit; uploads are <= 10 MB (25 MB PDFs) and page-image JSON <= 6 MB. Confirm on the first acceptance run.
8. **Missing UI** (section 4): version history and reordering are built; split/merge, metadata editing, TOC nesting and a rich editor are follow-ups. Confirm none is needed for the first release.
9. **Public canary route** (6.5, step 5): the Doorway owner must agree to one public exact route, `/manifold-companion/api/health`. Without it the canary is the Workers Logs check in 6.3.

## 8. Rules for whoever continues

- Every route calls `requireRole`/`requireTextRole` once and gets an authz-matrix row; never read a subject from a request body or header other than through `authenticate`.
- No hidden retry, no server-side bulk model loop, no provider key, no spend ledger, no lookup of people by email or name.
- Stored HTML passes `sanitizeHtml` and is shown only in the sandboxed preview; never in the app origin.
- Logging goes through `src/logging.ts` only (`npm run check:logging`); never log prompts, files, names, subjects, tokens or exception messages.
- Never edit an applied migration; add a new one and regenerate `test/schema.snapshot.json` deliberately (empty it to `{}`, run the migrations test, review the printed snapshot). No migration may mention FTS5.
- Deletion is rows first with a tombstone, then R2.
- No AI attribution in commits, code or docs (repository `CLAUDE.md`).
