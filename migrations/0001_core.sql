-- Core schema for servicetitan-mcp-server. Apply with: wrangler d1 migrations apply <db> --remote
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  surface TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT,
  dry_run INTEGER DEFAULT 0,
  payload TEXT,
  result TEXT,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  correlation TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_correlation ON audit_log(correlation);
CREATE INDEX IF NOT EXISTS idx_audit_log_surface_op ON audit_log(surface, operation);
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,
  alerted INTEGER DEFAULT 0,
  correlation TEXT
);
CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log(ts);
CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log(source);
CREATE TABLE IF NOT EXISTS mcp_cache (
  ns TEXT NOT NULL,
  k TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (ns, k)
);
CREATE INDEX IF NOT EXISTS idx_mcp_cache_expires ON mcp_cache(expires_at);
CREATE TABLE IF NOT EXISTS confirmation_tokens (
  token_hash TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  correlation TEXT
);
CREATE INDEX IF NOT EXISTS idx_confirm_tokens_expires ON confirmation_tokens(expires_at);
CREATE TABLE IF NOT EXISTS otel_span_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL,
  parent_span_id  TEXT,
  service_name    TEXT NOT NULL DEFAULT 'servicetitan-mcp-server',
  operation       TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'default',
  run_kind    TEXT NOT NULL,
  status          TEXT NOT NULL,
  latency_ms      INTEGER,
  input_redacted  TEXT,
  output_redacted TEXT,
  attrs_json      TEXT,
  shipped         INTEGER NOT NULL DEFAULT 0,
  shipped_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_otel_span_queue_unshipped ON otel_span_queue(shipped, ts);
CREATE TABLE IF NOT EXISTS mcp_operations (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, role TEXT NOT NULL, tool TEXT NOT NULL,
 args_hash TEXT NOT NULL, state TEXT NOT NULL, instance_id TEXT,
 result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_operations_owner ON mcp_operations(owner, created_at);
CREATE TABLE IF NOT EXISTS mcp_result_pages (
 id TEXT NOT NULL, page INTEGER NOT NULL, owner TEXT NOT NULL, role TEXT NOT NULL,
 tool TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(id, page)
);
CREATE INDEX IF NOT EXISTS idx_mcp_result_expiry ON mcp_result_pages(expires_at);
CREATE TABLE IF NOT EXISTS mcp_confirmation_owners (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_report_queries (
 k TEXT PRIMARY KEY, token TEXT, result TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_cache_flights (
 ns TEXT NOT NULL, k TEXT NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(ns, k)
);
CREATE TABLE IF NOT EXISTS mcp_report_runs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  role TEXT NOT NULL,
  category_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  token TEXT,
  state TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_report_runs_expiry ON mcp_report_runs(expires_at);
