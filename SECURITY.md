# Security policy

## Reporting a vulnerability

GitHub private vulnerability reporting must be enabled on this repository (Settings → Security → "Private vulnerability reporting"). Once enabled, report a vulnerability through the Security tab ("Report a vulnerability"). Please do not open a public issue for a security problem. Reports are acknowledged within five business days.

## Supported versions

Only the latest release receives fixes.

## Deployment guidance

- Keep `ST_CLIENT_SECRET`, `ST_APP_KEY`, `MCP_TOKEN`, and `CONFIRMATION_SIGNING_KEY` as Wrangler secrets. Never put them in `wrangler.toml` or in git.
- Give the ServiceTitan app only the API scopes your tools need.
- Set `MCP_TOKEN_ROLE = "readonly"` or `MCP_LOCKDOWN = "true"` to serve no write tools.
- If `MCP_TOKEN` may have leaked, replace it with `npx wrangler secret put MCP_TOKEN`.
- The D1 audit log redacts personal and credential-shaped fields in tool arguments.
- A daily cron deletes expired write-confirmation tokens, result pages, cache rows, in-flight cache locks, and report runs (by their own `expires_at`), prunes `audit_log`/`error_log`/`otel_span_queue`/`mcp_operations`/`mcp_report_queries` rows older than `RETENTION_DAYS` (default 30), and sweeps `mcp_confirmation_owners` rows once their matching confirmation token is gone. See README's "Data retention".
