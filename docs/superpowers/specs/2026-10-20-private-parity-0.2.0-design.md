# Private parity for 0.2.0: design

Date: 2026-10-20. Owner: Luke Peluso.

## Intent

`servicetitan-mcp-server` (this repo, public) is a clean rebuild of a private ServiceTitan MCP server (v1.7.0), called "the upstream private build" below. The public repo stopped at 0.1.2 on 2026-09-27. Since then the upstream private build has gained tools and fixes that any ServiceTitan tenant could use. The owner is releasing the public repo and wants it caught up on everything except tools that depend on the maintainer's private data warehouse or third-party vendors.

"Parity" means: every private tool that only calls the ServiceTitan public API, plus the private fixes that apply to code this repo already has.

## Goals

1. Port the tools in the "In scope" table below.
2. Apply the private fixes listed under "Fixes to review" wherever this repo has the same flaw.
3. Ship as 0.2.0: README tool table, CHANGELOG entry, `package.json` version bump.
4. Deliver as a PR against `main`. The owner merges.

## Non-goals

- Tools that depend on the maintainer's private data warehouse or third-party vendors. They stay private.
- Live testing against a ServiceTitan tenant. The README keeps its "Preview release" note.
- Changing this repo's architecture or its existing tools beyond what a fix requires.

## Anti-goals (a failure even if it works)

- **Any private-deployment detail in the public repo**: a real tenant ID, internal hostnames, Cloudflare account or resource IDs, database project refs, tenant-specific ServiceTitan report IDs, employee or customer names, or ticket numbers in comments. The existing egress and core-import guards must stay green. Run `gitleaks detect --no-git --source . --redact` before opening the PR.
- **Porting the five quarantined writes.** Private withheld `book_job`, `hold_appointment`, `reschedule_appointment`, `create_call_with_campaign` and `st_post_marketing_attribution` on 2026-10-16 because ServiceTitan rejects the bodies they send. Do not port them.
- **Copying private files over wholesale.** Private files import private data-access and helper modules this repo does not have. Rebuild each tool in this repo's patterns.
- **A write tool that skips preview-then-confirm.** Every write uses this repo's existing confirmation-token flow (see `src/tools/sales/create_estimate_template.ts` and `src/tools/__tests__/write_tool_factory.test.ts`), and is hidden under `MCP_TOKEN_ROLE=readonly` and `MCP_LOCKDOWN`.

## Source of truth

The upstream private build, at its main branch (not a feature branch). Read the private tool for its behavior, input schema, description wording and safety phrases, and the ServiceTitan endpoint it calls. Then build it here.

## In scope

| Tool | Kind | Private file | ServiceTitan endpoint | Notes |
|---|---|---|---|---|
| `assign_technicians` | write | `src/tools/jobs/assign_technicians.ts` | `dispatch/v2/.../appointment-assignments/assign-technicians` | Ported, then held back from the 0.2.0 registry at final review (request contract not verified live; see CHANGELOG). |
| `sell_estimate` | write | `src/tools/estimates/update_estimate_status.ts` | `sales/v2/.../estimates/{id}/sell` | One private file holds all three |
| `unsell_estimate` | write | same | `.../unsell` | |
| `dismiss_estimate` | write | same | `.../dismiss` | |
| `create_recurring_service` | write | `src/tools/memberships/create_recurring_service.ts` | `memberships/v2/.../recurring-service-types/{id}/recurring-services` | |
| `st_create_material` | write | `src/tools/st_create_material.ts` | `pricebook/v2/.../materials` | Pricebook items use dynamic pricing; a 0 or null price is not "unpriced". Keep private's description wording on this. |
| `st_patch_material` | write | `src/tools/st_patch_material.ts` | `pricebook/v2/.../materials/{id}` | |
| `st_create_service` | write | `src/tools/st_create_service.ts` | `pricebook/v2/.../services` | Port main-branch behavior only. A later private change (description defaults to displayName/name) is on an unmerged branch; leave it out. |
| `st_patch_service` | write | `src/tools/st_patch_service.ts` | `pricebook/v2/.../services/{id}` | |
| `st_add_invoice_line_item` | write | `src/tools/invoicing/st_add_invoice_line_item.ts` | `accounting/v2/.../invoices/{id}/items` | |
| `st_create_adjustment_invoice` | write | `src/tools/invoicing/st_create_adjustment_invoice.ts` | `accounting/v2/.../invoices` | Private checks each SKU against a private pricebook cache before writing, because a bad SKU gets a 200 and a $0, item-less invoice that the API cannot delete. Keep that guard: resolve each SKU with a live pricebook lookup during the preview step and refuse to issue a confirmation token if any SKU fails to resolve. Keep the after-write check too. (Design call by Claude.) |
| `get_form_submission` | read | `src/tools/calls_forms/get_form_submission.ts` | `forms/v2/.../submissions` | Live path only. ST has no per-ID route and ignores the `ids` filter, so the live lookup scans one form's submissions: `formId` becomes required. Remove it from the README "not available" list and from `CUT_FROM_RELEASE_1`. (Design call by Claude.) |
| `list_service_categories` | read | `src/tools/pricebook/list_service_categories.ts` | `pricebook/v2/.../categories` | |
| `get_service_details` | read | `src/tools/pricebook/get_service_details.ts` | `pricebook/v2/.../services/{id}` | |
| `get_configurable_equipment_children` | read | `src/tools/pricebook/get_configurable_equipment_children.ts` | `pricebook/v2/.../equipment/{id}` | |
| `st_get_pricebook` | read | `src/tools/st_get_pricebook.ts` | `pricebook/v2/.../{assetType}` | |
| `st_list_jobs` | read | `src/tools/st_list_jobs.ts` | `jpm/v2/.../jobs` | |
| `st_list_customers` | read | `src/tools/st_list_customers.ts` | `crm/v2/.../customers` | |
| `st_get_customer` | read | `src/tools/st_get_customer.ts` | `crm/v2/.../customers/{id}` | Check overlap with this repo's `get_customer`; see "Left to the builder" |
| `st_list_appointments` | read | `src/tools/st_list_appointments.ts` | `jpm/v2/.../appointments` | |
| `customer_snapshot` | read | `src/tools/composites/customer_snapshot.ts` | crm customer + accounting invoices | Composite; rebuild the small helpers it needs from `composite-helpers` locally |
| `job_closeout_report` | read | `src/tools/composites/job_closeout_report.ts` | jpm job + appointments + accounting invoices | Composite |

"Live path only" means the private tool reads a private data cache first and falls back to ServiceTitan. Here it calls ServiceTitan directly through this repo's `backend/direct.ts`. Drop any freshness or cache fields from the output.

## Considered and left out

| Tool | Why |
|---|---|
| `dispatch_pro_alerts_list`, `dispatch_pro_ratio_list`, `dispatch_pro_utilization_list` | Hard-coded tenant-specific report IDs plus a private data cache. Revisit later as a configurable report ID. |
| `get_service_breakout`, `find_packages_with_item` | Depend on the maintainer's private data warehouse |
| `investigate_customer_job` | Built on a private-warehouse search tool |
| `identify_tech_by_phone`, `tech_drive_time_summary` | Private data cache only |
| `dispatch_override_audit` | Needs the private data warehouse |
| `opportunities_list`, `opportunity_get` | On the upstream main branch both read only the private data cache; the declared ST endpoint is never called. A live client would be new, untested code. Stays in `CUT_FROM_RELEASE_1`. (Design call by Claude.) |
| `job_cost_actuals` | Only the invoice read is live; job, timesheets, appointments, assignments, estimates and tech names come from the private data cache. Without it this is a new design, not a port. (Design call by Claude.) |
| Every other private tool (warehouse search, margin and drift audits, membership leaderboards, vendor integrations, debrief, connector status) | Depends on the maintainer's private data warehouse or third-party vendors |
| The five quarantined writes | Broken in private |

## Fixes to review

For each upstream fix below, read its diff, then check whether this repo has the same code. Apply the fix if it does. Record "not applicable" with a one-line reason in the PR body if it does not.

- OAuth state consistency: keep login and consent state where a read always sees the last write. **Apply (owner decision, 2026-10-20).** This repo keeps OAuth login and approval state in `OAUTH_KV` (`src/oauth.ts`); move it into a Durable Object as private did. Add the binding and migration to `wrangler.toml.example`, and put an upgrade note in the CHANGELOG telling 0.1.x users what to add before redeploying.
- First deployment of migrated Durable Objects: deploy-time handling for the new Durable Object migration.
- Snapshot cache: share one in-flight read between concurrent callers of the same snapshot. Only the parts that sit under the in-scope tools or shared ST client code.
- Full output schemas: declare a complete output schema for each tool. Apply to tools here. The deploy-gate half is private infra; skip it.
- Estimate listing completeness: keep pagination fields and reject malformed pages. Applies to `list_estimates_job`.
- Dependency patch for a critical proxy advisory. Bring the same dependency versions here if this repo has them. `npm run security:audit`, or `npm audit --omit=dev` if no such script exists, must be clean of critical and high.
- Tools-list parity tests: serve the tool list uncompacted, with a warning, if SDK internals change. Port if this repo's `tool-list-compact` has the same gap.

## Verification

- Each new tool has unit tests in this repo's style: mocked ServiceTitan responses, input validation, and for writes the preview/confirm path, the readonly-role hide, and the lockdown hide.
- `npm run typecheck`, `npm test`, the egress guard test and the core-import guard test all pass.
- `gitleaks` is clean.
- README tool table matches the registered tool list. Add a test for that if none exists.

## Release

- README: state next to the tool table that write tools need the bearer-token (`MCP_TOKEN`) login. OAuth sessions are always read-only in `src/public-entry.ts`; this is existing, intended behavior.

- Version `0.2.0` in `package.json` and README.
- A CHANGELOG entry that lists the added tools and the applied fixes.
- One PR against `main`, built on a feature branch. No direct push to `main`, no tag; the owner merges and tags.

## Left to the builder

- The order of work, and how to batch tools into tasks.
- Where each tool lives under `src/tools/` (follow the existing folders).
- Overlap with existing tools: `st_get_customer` vs `get_customer`, `st_list_jobs` vs `list_jobs_today`, `st_list_appointments` vs `get_job_appointments`. If a private tool is a strict subset of an existing public one, skip it and say so in the PR. Otherwise port it.
- Small helper modules needed by the composites.
