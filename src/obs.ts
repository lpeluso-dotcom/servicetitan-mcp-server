import type { Env } from './env';
import { scrub } from './safe-error';

const PAYLOAD_MAX = 4000;

export function jsonTruncate(value: unknown, max: number = PAYLOAD_MAX): string | null {
  if (value === null || value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return JSON.stringify({ _serialize_failed: true });
  }
  if (json.length <= max) return json;
  return JSON.stringify({
    _truncated: true,
    _orig_length: json.length,
    _slice: json.slice(0, max - 80),
  });
}

const SAFE_CONTEXT_KEYS = new Set([
  'status', 'tool', 'actor', 'correlation', 'correlation_id',
  'latency_ms', 'code', 'failures', 'source', 'severity',
  'op', 'kind', 'ms',
]);

export function safeContext(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SAFE_CONTEXT_KEYS.has(k)) {
      out[k] = v;
    } else {
      dropped.push(k);
    }
  }
  if (dropped.length > 0) out._dropped_keys = dropped;
  return out;
}

export interface AuditRow {
  actor: string;
  surface: string;
  operation: string;
  target_id?: string;
  dry_run?: boolean;
  payload?: unknown;
  result?: unknown;
  status: 'ok' | 'error' | 'verified' | 'partial' | 'rejected' | 'rate_limited' | 'outcome_unknown' | 'accepted' | 'running';
  latency_ms?: number;
  correlation?: string;
}

export interface ErrorRow {
  source: string;
  severity: 'fatal' | 'error' | 'warn';
  message: string;
  stack?: string;
  context?: unknown;
  correlation?: string;
}

export interface HeartbeatState {
  ok?: boolean;
  extra?: Record<string, unknown>;
}

export async function audit(env: Env, row: AuditRow): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log
         (ts, actor, surface, operation, target_id, dry_run, payload, result, status, latency_ms, correlation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        Date.now(),
        row.actor ?? 'unknown',
        row.surface ?? 'unknown',
        row.operation ?? 'unknown',
        row.target_id ?? null,
        row.dry_run ? 1 : 0,
        jsonTruncate(scrub(env, row.payload)),
        jsonTruncate(scrub(env, row.result)),
        row.status ?? 'ok',
        row.latency_ms ?? null,
        row.correlation ?? null
      )
      .run();
  } catch (e) {
    
    
    console.error('[obs.audit] operation failed');
  }
}

export async function error(env: Env, row: ErrorRow): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO error_log
         (ts, source, severity, message, stack, context, alerted, correlation)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    )
      .bind(
        Date.now(),
        row.source ?? 'worker:servicetitan-mcp-server',
        row.severity ?? 'error',
        String(scrub(env, row.message ?? 'unknown error')),
        null,
        jsonTruncate(scrub(env, safeContext(row.context))),
        row.correlation ?? null
      )
      .run();
  } catch (e) {
    
    console.error('[obs.error] operation failed');
  }
}

export interface MetricPoint {
  tool: string;
  latency_ms: number;
  status: 'ok' | 'error';
  source?: string;
}

export function metric(env: Env, point: MetricPoint): void {
  try {
    if (!env.MCP_METRICS) return;
    env.MCP_METRICS.writeDataPoint({
      indexes: [point.tool],
      blobs: [point.status, point.source ?? 'unknown'],
      doubles: [point.latency_ms],
    });
  } catch (e) {
    
    console.error('[obs.metric] operation failed');
  }
}

export async function heartbeat(
  env: Env,
  source: string,
  state: HeartbeatState = {}
): Promise<void> {
  try {
    if (!env.STATE_KV) return;
    const key = `heartbeat:${source}`;
    const existingRaw = await env.STATE_KV.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const now = Date.now();
    const ok = state.ok !== false;
    const next = {
      last_ok_ts: ok ? now : existing.last_ok_ts ?? null,
      last_error_ts: ok ? existing.last_error_ts ?? null : now,
      consecutive_errors: ok ? 0 : (existing.consecutive_errors ?? 0) + 1,
      extra: state.extra ?? existing.extra ?? null,
    };
    await env.STATE_KV.put(key, JSON.stringify(next));
  } catch (e) {
    
    console.error('[obs.heartbeat] operation failed');
  }
}
