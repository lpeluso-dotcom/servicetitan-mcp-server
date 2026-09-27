# servicetitan-mcp-server

A Model Context Protocol (MCP) server for the ServiceTitan public API. You deploy it to your own Cloudflare account with your own ServiceTitan app credentials. It gives an MCP client (Claude Code, Claude Desktop, or any client that speaks Streamable HTTP) read access to your ServiceTitan tenant plus a small set of writes that always preview first and need a confirmation token.

> **Preview release.** This version is covered by unit tests and a local deploy check, but has not yet been run end to end against a live ServiceTitan tenant. Try it on a sandbox or integration tenant first, and please report problems through the repository issues.

Version 0.1.2. MIT license.

## What you need

- A Cloudflare account (Workers, D1, KV, Durable Objects).
- Your own ServiceTitan developer app for your tenant: client ID, client secret, app key, and tenant ID. Grant it only the API scopes for the tools you plan to use.
- Node.js 24 and npm.

## Set up

```bash
npm ci
cp wrangler.toml.example wrangler.toml
npx wrangler login
npx wrangler d1 create servicetitan-mcp-server        # paste database_id into wrangler.toml
npx wrangler kv namespace create STATE_KV              # paste id into wrangler.toml
npx wrangler d1 migrations apply servicetitan-mcp-server --remote   # applies migrations/0001_core.sql
```

In `wrangler.toml` `[vars]`, set `ST_TENANT_ID` to your tenant ID and `ST_TIMEZONE` to your business time zone (an IANA name such as `America/Chicago`; it defaults to `America/New_York` if unset).

Set the secrets. `ST_CLIENT_ID`, `ST_CLIENT_SECRET`, and `ST_APP_KEY` come from your ServiceTitan developer app, not from you; `MCP_TOKEN` and `CONFIRMATION_SIGNING_KEY` are values you generate yourself (`openssl rand -hex 32`):

```bash
npx wrangler secret put ST_CLIENT_ID
npx wrangler secret put ST_CLIENT_SECRET
npx wrangler secret put ST_APP_KEY
npx wrangler secret put MCP_TOKEN                 # openssl rand -hex 32 — clients send this as a bearer token
npx wrangler secret put CONFIRMATION_SIGNING_KEY  # openssl rand -hex 32 — signs write confirmation tokens
```

Deploy and check:

```bash
npx wrangler deploy
curl https://<worker-name>.<your-account-subdomain>.workers.dev/health
```

## Connect a client

Claude Code:

```bash
claude mcp add --transport http servicetitan https://<worker-name>.<your-account-subdomain>.workers.dev/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

Other clients: Streamable HTTP endpoint `https://<worker-name>.<your-account-subdomain>.workers.dev/mcp` with header `Authorization: Bearer <MCP_TOKEN>`.

To give token holders read tools only, deploy with `MCP_TOKEN_ROLE=readonly` (no writes reach a caller holding `MCP_TOKEN`). To remove every write tool for everyone, set `MCP_LOCKDOWN = "true"`.

### Optional: per-user sign-in with Cloudflare Access

Instead of one shared token, users can sign in through Cloudflare Access with any identity provider Access supports. OAuth users get read tools only.

1. In Cloudflare Zero Trust, create a SaaS application using OIDC. Set its redirect URL to `https://<worker-name>.<your-account-subdomain>.workers.dev/callback`.
2. Create a second KV namespace and bind it as `OAUTH_KV` (see the commented block in `wrangler.toml.example`).
3. Set vars `SELF_ORIGIN` (your Worker URL), `ALLOWED_EMAILS` (comma-separated), and `ACCESS_ISSUER` (the issuer URL Access shows for the app).
4. Set secrets `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`.
5. Point clients at `https://<worker-name>.<your-account-subdomain>.workers.dev/mcp-oauth`.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `add_customer_note` | write | Append a note to a customer record. |
| `add_job_note` | write | Append a note to a job. |
| `create_estimate_template` | write | Create a new estimate template. |
| `create_proposal_template` | write | Create a proposal template (a tiered set of estimate templates, for example Good/Better/Best). |
| `create_task` | write | Create a task linked to a job. |
| `delete_estimate_template` | write | Soft-deactivates an estimate template (sets active=false) — reversible via update_estimate_template({templateId, active:true}). |
| `delete_proposal_template` | write | Delete a proposal template. |
| `find_customer` | read | Search ST customers by name or phone. |
| `find_technician_by_name` | read | Resolve a technician name (full or partial) to their technicianId and roster profile. |
| `get_call` | read | Get details for a telecom call record including duration, campaign attribution, and recording info. |
| `get_campaign_performance` | read | Get performance metrics for a campaign (leads, bookings, revenue) via ST Reporting API. |
| `get_capacity` | read | Get dispatch capacity for business units over a date range (POST to ST /dispatch/v2/.../capacity; the body carries the filters). |
| `get_customer` | read | Get a single ST customer by ID. |
| `get_customer_locations` | read | Get service locations for a customer. |
| `get_customer_membership` | read | Get memberships for a customer. |
| `get_estimate` | read | Get full details for a single estimate including line items and status. |
| `get_estimate_template` | read | Get full details for a single estimate template, including its line items. |
| `get_invoice` | read | Get full invoice details including line items and totals. |
| `get_invoice_balance` | read | Get the outstanding balance for an invoice. |
| `get_job` | read | Get a single ST job by ID. |
| `get_job_appointments` | read | Get appointments for a job. |
| `get_job_history` | read | Get the audit-log / event timeline for a single ST job: booking events, capacity-tool usage, status changes, reassignments, etc. |
| `get_proposal_tiers` | read | Return the tier ladder (for example Good/Better/Best) of a proposal template: each tier's order, proposalTypeOptionId, estimate template id and name, item count, and active flag, in assignment order. |
| `get_result_page` | read | Retrieve one authenticated, computed page from a previously offloaded result. |
| `get_technician_shifts` | read | Get scheduled shifts for a technician. |
| `inventory_receipts_list` | read | List ServiceTitan inventory receipts (incoming items from POs). |
| `inventory_transfers_list` | read | List ServiceTitan inventory transfers between warehouses. |
| `inventory_vendors_list` | read | List ServiceTitan inventory vendors. |
| `inventory_warehouses_list` | read | List ServiceTitan warehouses (storage locations for inventory). |
| `jobs_hold_reasons_list` | read | List ServiceTitan Job Hold reasons. |
| `list_campaigns` | read | List marketing campaigns. |
| `list_customer_jobs` | read | List jobs for a customer. |
| `list_estimate_templates` | read | List estimate templates (reusable line-item bundles used to build estimates). |
| `list_estimates_job` | read | List all estimates for a specific job. |
| `list_invoices_job` | read | List all invoices for a specific job. |
| `list_jobs_today` | read | List ServiceTitan jobs scheduled for TODAY in the configured time zone (ST_TIMEZONE, default America/New_York). |
| `list_memberships_active` | read | List active memberships. |
| `list_memberships_expiring` | read | List active memberships expiring within the next N days. |
| `list_non_job_events` | read | List non-job dispatch events (time-off, training, meetings) for technicians. |
| `list_open_tasks` | read | List open (incomplete) tasks. |
| `list_technicians_available` | read | List the active technician roster from ServiceTitan Settings. |
| `list_unpaid_invoices` | read | List invoices with an outstanding balance (unpaid or partially paid). |
| `payroll_job_timesheets_list` | read | List ServiceTitan payroll job timesheets (dispatched/arrived/done times per technician per appointment), with minute-truncated drive_minutes and working_minutes. |
| `payroll_location_rates_list` | read | List ServiceTitan location-based pay rates. |
| `payroll_non_job_timesheets_list` | read | List ServiceTitan non-job timesheets (meeting/training/admin time). |
| `payroll_payrolls_list` | read | List ServiceTitan payroll records (per-employee payroll runs). |
| `payroll_settings_get` | read | Get the tenant payroll configuration (pay period, overtime rules, etc.). |
| `search_materials` | read | Look up pricebook materials by exact `code` (tries raw, UPPERCASE, and UPPERCASE-hyphenated variants) or list them one page at a time with active/page/pageSize. |
| `search_pricebook_all` | read | Search the ServiceTitan pricebook across services, materials, and equipment. |
| `search_pricebook_services` | read | Look up pricebook services by exact `code` (tries raw, UPPERCASE, and UPPERCASE-hyphenated variants) or list them one page at a time with active/page/pageSize. |
| `search_pricebook_templates` | read | Find estimate templates and proposal templates whose name, internal name, or summary contains every word of query. |
| `st_get_capacity_slots` | read | Return bookable capacity SLOTS for a date range (the slot-finder used for live availability). |
| `st_operation_status` | read | Recover a previously submitted write by operation_id, from a computed, local record of its current status. |
| `st_report_results` | read | Retrieve a completed or partial persisted report result without polling or resubmitting. |
| `st_report_start` | read | Start one ServiceTitan native report without long polling. |
| `st_report_status` | read | Perform one bounded status check for a persisted report run. |
| `st_run_report` | read | Run or discover ServiceTitan native reports. |
| `update_estimate_template` | write | Update an estimate template. |
| `update_proposal_template` | write | Update a proposal template. |

## Write safety

Every write takes two calls. The first, with `dryRun=true` (the default), returns a preview and a `confirmation_token`. The token expires after 15 minutes and is tied to the exact arguments and caller. The second call, with `dryRun=false` and that token, performs the write. Changing any argument invalidates the token. If a write's outcome is unknown, call `st_operation_status`; do not submit the write again.

Deploy with `MCP_TOKEN_ROLE=readonly` and no write tool is served to `MCP_TOKEN` holders at all — only the tools marked **read** in the table above. The write tools are exactly the tools marked **write** there: every tool in `PUBLIC_TOOLS` (`src/tools/public-registry.ts`) with `isWrite: true`. One exception: readonly callers can still call `st_run_report` to cancel its own timed-out report query — that housekeeping call touches no business data.

Set `READONLY=1` as an extra kill switch: it blocks every write at confirmation-token verification (the second, `dryRun=false` call), independent of `MCP_TOKEN_ROLE` and `MCP_LOCKDOWN`. Useful for freezing writes on a deploy without touching role config — for example a staging environment, or an emergency pause.

## Rate limits

ServiceTitan allows 60 calls per second per app per tenant, and one run of the same report per minute. A Durable Object paces every call against a fixed one-second window, which can let a short burst through at up to roughly twice `ST_RATE_LIMIT_PER_SEC` before the window resets. `ST_RATE_LIMIT_PER_SEC` sets the budget: recommended 30; values up to 60 are accepted, but bursts can reach about 2x the setting, so a value near 60 can itself approach or exceed ServiceTitan's real ceiling, especially if another integration shares the same ServiceTitan app.

## Data retention

A daily cron (`[triggers]` in `wrangler.toml.example`) deletes expired or old rows from this build's own D1. `mcp_result_pages`, `mcp_cache`, `confirmation_tokens`, `mcp_cache_flights`, and `mcp_report_runs` are deleted once past their own `expires_at`; `audit_log`, `error_log`, `otel_span_queue`, `mcp_operations`, and `mcp_report_queries` are deleted once older than `RETENTION_DAYS` (default 30); `mcp_confirmation_owners` has no timestamp of its own, so it's swept once its matching `confirmation_tokens` row is gone. All tables share one ~20-second wall-clock budget per cron run, not one budget per table: each table deletes in batches of 500 until a batch comes back with fewer than 500 rows, then the cron moves to the next table, until that one shared budget runs out — so a large backlog drains over a few days rather than in one run. Set `RETENTION_DAYS` to change the window.

## Known limits

- `role` is always `null` in `find_technician_by_name`. ServiceTitan's public technicians endpoint exposes only role IDs, not role names, so this tool cannot resolve a role string from the public API alone.
- Proposal template `categoryIds` cannot be set through the public API. ServiceTitan's public API accepts the field and silently drops it, so `create_proposal_template` and `update_proposal_template` refuse it outright rather than pretend it took effect. Set categories in the ServiceTitan UI.
- The payroll timesheets `technicianId` filter isn't supported. ServiceTitan's live job-timesheets endpoint cannot filter by `technicianId` (or `appointmentId` or the `arrived*` filters); `payroll_job_timesheets_list` rejects them. Pass `jobId` for one job, or page the tenant-wide list with `modifiedOnOrAfter` and filter the rows yourself.
- Pricebook search scans a bounded number of pages and says so when it stops early. ServiceTitan has no server-side pricebook or template text search, so `search_pricebook_all` / `search_pricebook_services` / `search_materials` scan up to 3,200 rows per catalog (services, materials, equipment) and `search_pricebook_templates` scans up to 1,000 templates per kind; a scan that hits its page cap before finding every match reports it in `_warnings` instead of silently returning a partial result as if it were complete.
- ServiceTitan list endpoints ignore filters they do not support and return unfiltered rows. Tools either refuse such filters outright or re-check the returned rows and report any removed rows in `_warnings`.
- A price of 0 or blank can mean the item is priced dynamically, not that it is free or unpriced.
- Not included in this release:

  - `find_packages_with_item`: Which templates contain a given item is not available through ServiceTitan's public API — there is no reverse lookup from item to template.
  - `get_service_breakout`: The exploded contents of a service kit are not available through ServiceTitan's public API.
  - `get_form_submission`: Form submission data is not available through ServiceTitan's public API.
  - `opportunities_list`: no public ServiceTitan endpoint
  - `opportunity_get`: no public ServiceTitan endpoint

## Forms kit

`forms/` holds a separate toolkit for building ServiceTitan native forms (Form 2.0) as import-ready JSON: the format reference, an import checklist, a JSON Schema, three example forms, and a small Python generator and checker (standard library only). It needs no credentials and does not use the MCP server. It is also written as instructions for an AI assistant: point the assistant at `forms/SKILL.md`. Start with `forms/README.md`.

## Troubleshooting

A missing or invalid setup value (a secret you forgot to set, an unsupported
`ST_BACKEND`, or an unset/placeholder `ST_TENANT_ID`) fails clearly, naming
the exact variable — it never just shows up as a generic "Request failed"
error. If a tool call fails and the reason isn't obvious from the response,
run `npx wrangler tail` while you retry the call: configuration errors are
logged there immediately, without needing to reproduce anything.

## Development

```bash
npm run typecheck
npm test
cp .dev.vars.example .dev.vars   # fill in, never commit
npx wrangler d1 migrations apply servicetitan-mcp-server --local   # applies migrations/0001_core.sql
npx wrangler dev
```

## License

MIT. See `LICENSE`.

## Ownership and disclaimer

Copyright © 2026 Quality Service Company. Released under the MIT License (see `LICENSE`). Maintained by Luke Peluso.

Quality Service Company holds the copyright in this software and nothing more. It provides the software "as is", without warranty of any kind, and accepts no liability for any use of it, any deployment of it, or any fork or derivative of it. Publishing this software is not an endorsement, and Quality Service Company does not support, warrant, or vouch for this project or anything built with it. Please direct questions and issues to this repository, not to Quality Service Company.

This project is not affiliated with, endorsed by, or supported by ServiceTitan, Inc. ServiceTitan is a trademark of its owner and is used here only to describe what the software works with.
