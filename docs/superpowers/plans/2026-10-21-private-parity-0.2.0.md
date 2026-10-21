# Private parity 0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port 22 ServiceTitan-API-only tools and the applicable fixes from the upstream private build into this public repo and ship 0.2.0.

**Architecture:** Each tool is rebuilt in this repo's own patterns: reads use `readST`/`readSTPaged` from `src/st.ts` and `cacheGet`; writes use `defineWriteTool` (`src/write-tool-factory.ts`) or `WriteGate` (`src/write-gate.ts`) directly when the private tool does. Tools register through `PUBLIC_TOOLS` in `src/tools/public-registry.ts`. No private data-cache, data-warehouse, or private helper modules come across.

**Tech Stack:** TypeScript, Cloudflare Workers, zod 4, vitest, `@modelcontextprotocol` SDK.

**Spec:** `docs/superpowers/specs/2026-10-20-private-parity-0.2.0-design.md`

**Private source:** the upstream private build, always read at its main branch. Never its working tree (it is on another branch).

## Global Constraints

- No private-deployment detail anywhere in the repo: no real tenant ID (placeholder stays `000000000`), no internal hostnames, Cloudflare or database IDs, tenant-specific report IDs, people's names, real invoice/job IDs from incidents, or internal ticket references. Rewrite private comments to state the reason without the reference.
- Do not port `book_job`, `hold_appointment`, `reschedule_appointment`, `create_call_with_campaign`, `st_post_marketing_attribution`.
- Every write tool: preview-then-confirm token, `isWrite: true`, hidden for `readonly` and `lockdown` roles (via `filterToolsForRole`).
- "Live path only": call ServiceTitan directly; drop private-cache branches and any `_freshness`/cache fields from output.
- Keep private's tool names, input schemas, and description safety phrases unless this plan says otherwise.
- `npm run typecheck` and `npx vitest run` green after every task. Baseline: 62 files, 442 tests passing.
- Commit per task on branch `feat/private-parity-0.2.0`, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A write called with `dryRun:false` and a token minted for different args must be rejected. Each write task asserts this for one of its tools.
2. A ServiceTitan 404 on a read (bad id) must come back as a clean tool error, not a thrown stack. Each read task asserts this for one tool.
3. Paged list reads must not silently truncate. Where `readSTPaged` stops at its page cap, output must carry `hasMore: true` (or the repo's existing truncation field). Task 2 and Task 10 assert this.
4. Adjustment invoice with a SKU that does not resolve must never reach the POST (Task 8).
5. A stray private-deployment string slipping in through a ported comment. Task 1 adds a hygiene test that scans `src/` and `README.md`.

---

### Task 1: Public hygiene guard and pricebook reads

**Files:**
- Create: `src/__tests__/public-hygiene.test.ts`
- Create: `src/tools/pricebook/list_service_categories.ts`, `get_service_details.ts`, `get_configurable_equipment_children.ts`
- Create: `src/tools/st_get_pricebook.ts`
- Modify: `src/tools/public-registry.ts` (import and add to `PUBLIC_TOOLS` in a new pricebook group)
- Test: `src/tools/pricebook/__tests__/pricebook_reads.test.ts`

**Interfaces:**
- Produces: `FORBIDDEN_PUBLIC_PATTERNS: readonly RegExp[]` exported from `src/__tests__/public-hygiene.test.ts`'s sibling `src/__tests__/guards/public-hygiene.ts`, plus `scanForForbidden(root: string): GuardViolation[]` (reuse `GuardViolation` from `guards/egress-scan.ts`).

- [ ] **Step 1: Write failing hygiene test.** `it('src and README carry no private-deployment references')`: `expect(scanForForbidden(repoRoot)).toEqual([])`. Patterns (case-insensitive) cover ticket refs, the company name, internal host names, the maintainer's account name, and private data-store module names; the list lives in `src/__tests__/guards/public-hygiene.ts`. Scans `src/**/*.ts` and `README.md`, skipping this guard file itself. Also `it('flags a planted string')` on a temp dir with a planted ticket ref → one violation.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/public-hygiene.test.ts`. Expected: FAIL (module missing). If the existing tree already trips a pattern, fix the offending text in this task (do not loosen the pattern), except a private data-store name inside `CUT_FROM_RELEASE_1` reasons. If one exists, reword it.
- [ ] **Step 3: Implement** `src/__tests__/guards/public-hygiene.ts`.
- [ ] **Step 4: Write failing pricebook read tests**: for each of the 4 tools, mock `readST` (as `src/tools/__tests__/get_job_history.test.ts` does) and assert the request path (`/pricebook/v2/tenant/000000000/categories`, `/services/{id}`, `/equipment/{id}`, `/{assetType}`), the returned shape matches private's, and `get_service_details` on a mocked 404 resolves to the repo's tool-error shape (Review Focus 2). `st_get_pricebook` rejects an `assetType` outside its enum.
- [ ] **Step 5: Run.** Expected: FAIL (modules missing).
- [ ] **Step 6: Port the 4 tools** from private (`src/tools/pricebook/list_service_categories.ts`, `get_service_details.ts`, `get_configurable_equipment_children.ts`, `src/tools/st_get_pricebook.ts`). Imports map 1:1 to this repo's `cache`, `st`, `errors`, `response-shape`, `../index`.
- [ ] **Step 7: Run full suite + typecheck.** Expected: all green. `public-entry.test.ts` picks up new tools automatically.
- [ ] **Step 8: Commit** `feat: hygiene guard and pricebook read tools`.

### Task 2: Generic ST list/get reads

**Files:**
- Create: `src/tools/st_list_jobs.ts`, `st_list_customers.ts`, `st_get_customer.ts`, `st_list_appointments.ts`
- Modify: `src/tools/public-registry.ts`
- Test: `src/tools/__tests__/st_generic_reads.test.ts`

**Interfaces:** Consumes Task 1 registry group layout.

- [ ] **Step 1: Overlap check.** Compare each against `get_customer`, `list_jobs_today_public`, `get_job_appointments`. Private's `st_*` tools take filter args (date ranges, status, paging) that the public ones do not, so port all four unless one is a strict subset. Record the result in the commit message.
- [ ] **Step 2: Write failing tests**: path and query params forwarded (e.g. `st_list_jobs` with `jobStatus`, `createdOnOrAfter` → query string contains both), `st_get_customer` 404 → tool error, a paged list mocked to return `hasMore: true` surfaces `hasMore: true` in output (Review Focus 3).
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Port** the four files from private `src/tools/`.
- [ ] **Step 5: Run full suite + typecheck.** Expected: green.
- [ ] **Step 6: Commit** `feat: generic ServiceTitan list and get tools`.

### Task 3: get_form_submission, live only

**Files:**
- Create: `src/tools/calls_forms/get_form_submission.ts`
- Modify: `src/tools/public-registry.ts` (add to `PUBLIC_TOOLS`; delete `get_form_submission` key from `CUT_FROM_RELEASE_1`)
- Test: `src/tools/calls_forms/__tests__/get_form_submission.test.ts`

- [ ] **Step 1: Write failing tests.** `formId` and `submissionId` both required in the zod schema (`safeParse({submissionId: 1})` fails). The handler pages `/forms/v2/tenant/000000000/submissions?formIds={formId}` until it finds `id === submissionId`. Returns `{ submission, _source: 'live' }`. Not found after the scan → tool error naming both ids. No `_freshness` key in output. The description says the lookup scans one form's submissions because ServiceTitan has no per-ID route.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** from private's live branch only; use `readSTPaged`.
- [ ] **Step 4: Run full suite + typecheck.** Expected: green.
- [ ] **Step 5: Commit** `feat: get_form_submission (live, formId required)`.

### Task 4: Composites customer_snapshot and job_closeout_report

**Files:**
- Create: `src/tools/composites/composite-helpers.ts` (only the helpers these two use)
- Create: `src/tools/composites/customer_snapshot.ts`, `job_closeout_report.ts`
- Modify: `src/tools/public-registry.ts`
- Test: `src/tools/composites/__tests__/composites.test.ts`

- [ ] **Step 1: Read** the private composite helpers, the two composite tools, and the private test cases for them (composites, composite helpers, singleflight). Copy only the helpers referenced. If a helper reads a private data store, drop that branch.
- [ ] **Step 2: Write failing tests** ported from those private cases. They must include: the parallel sub-reads hit `/crm/.../customers/{id}`, `/accounting/.../invoices?customerId=` (snapshot) and `/jpm/.../jobs/{id}`, `/jpm/.../appointments?jobId=`, `/accounting/.../invoices?jobId=` (closeout); one failing sub-read yields a partial result with that section marked as an error, not a thrown error; and the singleflight case from the upstream snapshot-cache fix.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Port.**
- [ ] **Step 5: Run full suite + typecheck.** Expected: green.
- [ ] **Step 6: Commit** `feat: customer_snapshot and job_closeout_report composites`.

### Task 5: Estimate status, recurring service, assign technicians writes

**Files:**
- Create: `src/tools/estimates/update_estimate_status.ts` (exports `sell_estimate`, `unsell_estimate`, `dismiss_estimate`)
- Create: `src/tools/memberships/create_recurring_service.ts`
- Create: `src/tools/jobs/assign_technicians.ts`
- Modify: `src/tools/public-registry.ts`
- Test: `src/tools/__tests__/simple_writes.test.ts`

- [ ] **Step 1: Write failing tests** in the style of `src/tools/__tests__/write_tool_factory.test.ts`. Each tool's dry run returns `confirmation_token` and makes no ST call. A confirm with a valid token POSTs (or PUTs, per private) to the private endpoint: `/sales/v2/tenant/000000000/estimates/{id}/sell|unsell|dismiss`, `/memberships/v2/.../recurring-service-types/{serviceTypeId}/recurring-services`, `/dispatch/v2/.../appointment-assignments/assign-technicians`. `sell_estimate` confirmed with a token minted for a different `estimateId` → rejected (Review Focus 1). All five absent from `filterToolsForRole(PUBLIC_TOOLS,'readonly')` and `'lockdown'`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Port** from private. `assign_technicians` uses `WriteGate` + `rate-limit-guard` directly; both exist here.
- [ ] **Step 4: Run full suite + typecheck.** Expected: green.
- [ ] **Step 5: Commit** `feat: estimate status, recurring service and technician assignment writes`.

### Task 6: Pricebook writes

**Files:**
- Create: `src/tools/pricebook-payload.ts`, `src/tools/st_patch_service.ts`, `st_create_service.ts`, `st_patch_material.ts`, `st_create_material.ts`
- Modify: `src/tools/public-registry.ts`
- Test: `src/tools/__tests__/pricebook_writes.test.ts`

- [ ] **Step 1: Read** the upstream main-branch versions of all five plus their tests.
- [ ] **Step 2: Write failing tests**, ported from private's plus: dry run makes no ST call; confirm hits `POST /pricebook/v2/tenant/000000000/services` / `PATCH .../services/{id}` (and the material equivalents); `st_patch_material` with a token for a different `id` → rejected; the descriptions of `st_create_service` and `st_create_material` contain the dynamic-pricing note (assert on private's exact phrase).
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Port.** Use main-branch behavior only. Leave out the later description-defaulting change; it is on an unmerged branch.
- [ ] **Step 5: Run full suite + typecheck.** Expected: green.
- [ ] **Step 6: Commit** `feat: pricebook service and material writes`.

### Task 7: st_add_invoice_line_item

**Files:**
- Create: `src/tools/invoicing/invoice-verify.ts`, `src/tools/invoicing/st_add_invoice_line_item.ts`
- Modify: `src/tools/public-registry.ts`
- Test: `src/tools/invoicing/__tests__/st_add_invoice_line_item.test.ts`

- [ ] **Step 1: Read** private file (644 lines), `invoice-verify.ts`, and its tests (`git grep -l st_add_invoice_line_item origin/main -- 'src/**/__tests__/*'`).
- [ ] **Step 2: Write failing tests**, ported from private's. They must cover: the dry run reads the invoice and makes no write; the confirm PATCHes `/accounting/v2/tenant/000000000/invoices/{invoiceId}/items`; the post-write verify-read runs and reports a mismatch; a mismatched token is rejected.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Port.** Scrub incident references from comments.
- [ ] **Step 5: Run full suite + typecheck.** Expected: green.
- [ ] **Step 6: Commit** `feat: st_add_invoice_line_item with post-write verify`.

### Task 8: st_create_adjustment_invoice with live SKU resolve

**Files:**
- Create: `src/tools/invoicing/sku-resolve.ts` (live version)
- Create: `src/tools/invoicing/st_create_adjustment_invoice.ts`
- Modify: `src/tools/public-registry.ts` (add tool; delete `sku-resolve` key from `CUT_FROM_RELEASE_1`)
- Test: `src/tools/invoicing/__tests__/st_create_adjustment_invoice.test.ts`, `sku-resolve.test.ts`

**Interfaces:**
- Consumes: `CATALOG_PATHS`, `CatalogKind` from `src/tools/pricebook/catalog-scan.ts`; code variants from `src/tools/pricebook/code-variants.ts`.
- Produces: `resolveSku(env, ctx, skuName: string): Promise<SkuResolution>` where `SkuResolution = { status:'resolved'; skuName; matched; kind: CatalogKind } | { status:'not_found'; skuName } | { status:'unavailable'; skuName; reason: string }`.

- [ ] **Step 1: Write failing `sku-resolve` tests**: an exact code match on services → `resolved`; a match only on materials → `resolved` with `kind:'material'`; no match in any catalog → `not_found`; ST read throws → `unavailable`. Lookup goes through `readST` against the pricebook `services`/`materials`/`equipment` paths filtered by code/name; no private data cache.
- [ ] **Step 2: Write failing tool tests** ported from private's, plus these. Any line `not_found` → dry run returns a validation error, issues **no** confirmation token, and makes no POST (Review Focus 4). If any SKU is `unavailable` → **fail closed**: same validation error, saying the SKU could not be verified. (This differs from private's fail-open, which relied on a private cache. Here the only check is live, and a silent $0 invoice can't be deleted through the API.) If all SKUs resolve → token issued; the confirm POSTs `/accounting/v2/tenant/000000000/invoices`, and the post-write verify flags a zero-item result. The description states that adjustment invoices cannot be deleted through the API.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement** `sku-resolve.ts` and port the tool. Resolve SKUs in the dry-run step and again at confirm.
- [ ] **Step 5: Run full suite + typecheck.** Expected: green.
- [ ] **Step 6: Commit** `feat: st_create_adjustment_invoice with live SKU pre-check`.

### Task 9: OAuth flow state in a Durable Object (upstream OAuth state fix)

**Files:**
- Create: `src/durable/oauth-flow-state.ts`, `src/__tests__/oauth-flow-state-stub.ts`
- Modify: `src/oauth.ts`, `src/env.ts`, `src/index.ts` (export the DO class), `vitest.setup.ts`, `wrangler.toml.example` (binding `OAUTH_FLOW_STATE` + a new `[[migrations]]` tag after the existing ones), the 4 oauth tests, `README.md` (Access sign-in steps)
- Test: existing `src/__tests__/oauth-*.test.ts`

- [ ] **Step 1: Read** the upstream OAuth state fix's diff. Map each hunk onto this repo's `src/oauth.ts` (state currently in `OAUTH_KV` around lines 164-242).
- [ ] **Step 2: Write failing test** in `oauth-consent.test.ts`: a consent POST immediately after the authorize GET finds its state even when the KV stub returns `null` for that key (eventual-consistency case). This is the bug the fix closes.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Apply** the private change, adapting names to this repo. Use the binding name from private.
- [ ] **Step 5: Run full suite + typecheck.** Expected: green.
- [ ] **Step 6: Commit** `fix: keep OAuth flow state in a Durable Object`.

### Task 10: Remaining fixes

**Files:**
- Modify: `src/tools/estimates/list_estimates_job.ts` (+ test `src/tools/estimates/__tests__/list-estimates-pagination.test.ts`)
- Modify: `src/tool-list-compact.ts`, `src/index.ts`/`src/public-entry.ts` as needed (+ `src/__tests__/tool-list-compact.test.ts`)
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Estimate pagination.** Port private's `list-estimates-pagination.test.ts` case. Run it. Expected FAIL if public has the gap; if it passes as-is, record "not applicable" for the PR. Apply the `list_estimates_job.ts` hunk. Skip the new `estimate_reference_evidence` tool (not in spec).
- [ ] **Step 2: Tools-list fail-soft.** Port the new `tool-list-compact.test.ts` case for "SDK internals changed → list still served uncompacted, no throw", and the protocol parity assertions where this repo has a matching test. Run, expect FAIL, apply the `tool-list-compact.ts` hunk, run, expect PASS.
- [ ] **Step 3: Dependencies.** `npm audit --omit=dev` currently reports 3 high (`@modelcontextprotocol/client`, `/server` pinned at `2.0.0`, `@modelcontextprotocol/sdk <=1.31.0`) and 1 moderate (`hono`). Bump to the lowest patched versions (match private's where it uses the same package), `npm install`, then run full suite + typecheck. Expected: green, and `npm audit --omit=dev` shows 0 critical and 0 high.
- [ ] **Step 4: N/A notes.** The upstream output-schema test only covers private-only tools; the Durable Object first-deploy fix and the deploy-gate halves are private infra. List these for the PR body.
- [ ] **Step 5: Commit** `fix: estimate pagination, tools-list fail-soft, dependency advisories`.

### Task 11: Release 0.2.0

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`
- Create: `src/__tests__/readme-tools.test.ts`

- [ ] **Step 1: Write failing test** `README tool table lists exactly PUBLIC_TOOLS`: parse rows matching ``/^\| `([a-z0-9_]+)` \|/m`` from `README.md` and compare the sorted set to `PUBLIC_TOOLS.map(t=>t.name)`. Each row's Kind column is `write` iff `isWrite`.
- [ ] **Step 2: Run.** Expected: FAIL (new tools missing).
- [ ] **Step 3: Update README.** Add rows (descriptions from each tool's first sentence). Remove `get_form_submission` from the not-available list. Change "Version 0.1.x" to 0.2.0. Under the tool table, add: "Write tools need the bearer-token (`MCP_TOKEN`) login. OAuth sessions are read-only." Keep the Preview note.
- [ ] **Step 4: CHANGELOG** `## 0.2.0`: Added (22 tools by name), Fixed (OAuth flow state, estimate pagination, tools-list fail-soft, dependency advisories), **Upgrading from 0.1.x** (add the `OAUTH_FLOW_STATE` Durable Object binding and migration from `wrangler.toml.example` before `wrangler deploy`).
- [ ] **Step 5: Bump** `package.json` to `0.2.0`; `npm install --package-lock-only`.
- [ ] **Step 6: Verify.** `npm run typecheck && npx vitest run` green; `gitleaks detect --no-git --source . --redact` clean (if gitleaks is not installed, `npx --yes gitleaks` or say so in the PR); `npm audit --omit=dev` 0 high/critical.
- [ ] **Step 7: Commit** `chore: release 0.2.0`.
