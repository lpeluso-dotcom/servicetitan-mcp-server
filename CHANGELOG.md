# Changelog

## 0.2.0 (2026-10-21)

### Added

21 tools, bringing the total to 80.

- Writes (10, each preview-then-confirm, hidden for `readonly` and lockdown callers): `sell_estimate`, `unsell_estimate`, `dismiss_estimate`, `st_add_invoice_line_item`, `st_create_adjustment_invoice`, `create_recurring_service`, `st_patch_service`, `st_create_service`, `st_patch_material`, `st_create_material`.
- Reads (11): `get_form_submission`, `list_service_categories`, `get_service_details`, `get_configurable_equipment_children`, `st_get_pricebook`, `st_list_jobs`, `st_list_customers`, `st_get_customer`, `st_list_appointments`, `customer_snapshot`, `job_closeout_report`.
- Pricebook writes (`st_patch_service`, `st_create_service`, `st_patch_material`, `st_create_material`) now read the item back after the write and report which fields were verified and which did not match.
- `st_create_adjustment_invoice` checks each SKU against the live pricebook before the write. It fails closed if any SKU cannot be verified, matches by pricebook code only (not display name), and sends the resolved code.
- `get_form_submission` requires both `formId` and `submissionId`. It was listed as unavailable in 0.1.x.
- Held back: `assign_technicians` is not registered in 0.2.0. ServiceTitan's appointment-assignment request contract (path and body field names) is not yet verified against a live tenant, and the two-step unassign/assign is not atomic.

### Fixed

- OAuth login and consent state moved from KV (eventually consistent) to a Durable Object, so a sign-in no longer fails on a stale read.
- `list_estimates_job` reports `pagination` (`has_more`, `next_page`, `complete`) instead of silently truncating, and rejects malformed pages.
- Tools-list compaction fails soft and logs a warning if the MCP SDK internals it depends on change.
- Production dependency advisories patched: `@modelcontextprotocol/sdk` 1.32.0, `@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.3.0, `hono` 4.13.11. `npm audit --omit=dev` is clean.

### Upgrading from 0.1.x

If you use Cloudflare Access sign-in, add the `OAUTH_FLOW_STATE` Durable Object binding (class `OAuthFlowState`) and the `[[migrations]]` entry with `tag = "v2"` and `new_sqlite_classes = ["OAuthFlowState"]`. Copy both from `wrangler.toml.example` before you run `wrangler deploy`. Until you add them, the OAuth routes answer `503 oauth_not_configured`. Bearer-token `/mcp` keeps working either way. Deploys that only use `MCP_TOKEN` need no change.

## 0.1.2 (2026-09-27)

- Added `forms/`, a kit for building ServiceTitan native forms (Form 2.0) as import-ready JSON: format reference, import checklist, JSON Schema, example forms, and a Python generator and checker. It is written to be used directly by an AI assistant (`forms/SKILL.md`).

## 0.1.1 (2026-09-25)

First public release.
