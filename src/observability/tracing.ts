import { resolveTrace } from './correlation';
import { SPAN_ACTOR_COLUMN, SPAN_RUN_KIND_COLUMN } from './span-columns';

export type RunKind = 'interactive' | 'cron' | 'webhook' | 'backfill';
export interface TracerEnv { DB: D1Database; }
export type ToolSpanEnv = TracerEnv;

interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operation: string;
  actor: string;
  service: string;
  runKind: RunKind;
  status: 'ok' | 'error';
  latencyMs: number;
  attrs: Record<string, unknown>;
}


async function writeSpanRow(env: TracerEnv, row: SpanRow): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO otel_span_queue
         (ts, trace_id, span_id, parent_span_id, service_name, operation, ${SPAN_ACTOR_COLUMN}, ${SPAN_RUN_KIND_COLUMN}, status, latency_ms, attrs_json, shipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(
      Date.now(), row.traceId, row.spanId, row.parentSpanId, row.service, row.operation,
      row.actor, row.runKind, row.status, row.latencyMs, JSON.stringify(row.attrs),
    ).run();
  } catch (e: any) {
    console.error('[observability.tracing] otel_span_queue write failed');
  }
}


export async function traceTool(
  env: ToolSpanEnv,
  operation: string,
  actor: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<{ status: 'ok' | 'error'; latencyMs: number }>,
): Promise<void> {
  const resolved = resolveTrace(undefined);
  const t0 = Date.now();
  try {
    const outcome = await fn();
    await writeSpanRow(env, {
      traceId: resolved.traceId, spanId: resolved.spanId, parentSpanId: null,
      operation, actor, service: 'servicetitan-mcp-server', runKind: 'interactive',
      status: outcome.status, latencyMs: outcome.latencyMs, attrs,
    });
  } catch (e: any) {
    
    
    await writeSpanRow(env, {
      traceId: resolved.traceId, spanId: resolved.spanId, parentSpanId: null,
      operation, actor, service: 'servicetitan-mcp-server', runKind: 'interactive',
      status: 'error', latencyMs: Date.now() - t0, attrs: { ...attrs, error: e?.message ?? String(e) },
    });
  }
}
