// ============================================================
// env.ts — Typed environment bindings for the public ServiceTitan MCP server.
// This build ships its own local D1, KV, and Durable Object only (see
// wrangler.toml.example) — no other bindings exist to type.
// ============================================================

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { BackendEnv } from './backend/env';
import type { OAuthFlowState } from './durable/oauth-flow-state';

export interface Env extends BackendEnv {
  // Bindings
  DB: D1Database;
  STATE_KV: KVNamespace;
  MCP_METRICS?: AnalyticsEngineDataset; // optional: per-tool latency telemetry; bind an Analytics Engine dataset to enable

  // Optional per-user sign-in via Cloudflare Access instead of one shared
  // MCP_TOKEN (see README, "Optional: per-user sign-in with Cloudflare
  // Access"). OAuth users get read tools only.
  OAUTH_KV: KVNamespace; // workers-oauth-provider store (clients/grants/tokens) + JWKS cache
  OAUTH_FLOW_STATE: DurableObjectNamespace<OAuthFlowState>; // strongly consistent, short-lived login/consent state
  ACCESS_CLIENT_ID: string; // Access SaaS-OIDC client id (var)
  ACCESS_CLIENT_SECRET: string; // Access SaaS-OIDC client secret (secret)
  ACCESS_ISSUER: string; // …/cdn-cgi/access/sso/oidc/<client_id> (var); endpoints derived
  ALLOWED_EMAILS?: string; // in-worker allow-list re-checked in /callback (var)
  SELF_ORIGIN?: string; // pinned callback origin, not the spoofable request Host (var)
  OAUTH_PROVIDER: OAuthHelpers; // injected by the provider before defaultHandler runs

  // Vars
  MCP_SERVICE_VERSION: string;
  ST_TENANT_ID: string;
  ST_RATE_LIMIT_PER_SEC?: string; // StRateLimiter per-second budget; see wrangler.toml.example
  READONLY?: string; // "1" blocks confirmation before token consumption or ST writes
  MCP_LOCKDOWN?: string; // "true" → server enters lockdown / read-only mode
  ST_TIMEZONE?: string; // IANA zone for "today" in list_jobs_today; unset = America/New_York
  MCP_TOKEN_ROLE?: string; // "readonly" serves only read tools to MCP_TOKEN holders
  VERIFY_BACKOFF_MS?: number[]; // test seam: waits between post-write verify-reads; default is 2s then 10s
  RETENTION_DAYS?: string; // days to keep audit_log/error_log/otel_span_queue/mcp_operations/mcp_report_queries rows; default 30

  // Secrets
  CONFIRMATION_SIGNING_KEY?: string; // signs write confirmation tokens; required (config_error if unset)
  CONFIRMATION_PREVIOUS_KEY?: string; // optional: previous signing key, honored during key rotation
  MCP_TOKEN?: string; // bearer token clients send to /mcp

  // Durable Object
  ST_RATE_LIMITER: DurableObjectNamespace;
}
