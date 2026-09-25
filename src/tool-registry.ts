import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env';
import type { ToolDef } from './tools/index';
import { z } from 'zod';
import { withBudget, stage } from './request-budget';
import { recoverableWrite, operationStatus } from './operations';
import { scopeFor } from './scope';
import { safeError, scrubDiagnostics } from './safe-error';
import { newCorrelationId } from './auth';
import { McpError } from './errors';
import * as obs from './obs';
import { traceTool } from './observability/tracing';
import { getResultPage, offloadIfLarge } from './resources/results';

export interface RequestContext {
  actor: string;
  principal?: string;
  signal?: AbortSignal;
  allowedTools?: readonly string[];
  availableTools?: readonly string[];
  role: 'default' | 'admin' | 'lockdown' | 'readonly';
}

export const PII_FIELD_PATTERNS: readonly RegExp[] = [
  /^phone/i, /Phone$/i,
  /^email/i, /Email$/i,
  /^name$/i, /Name$/i,
  /^street/i, /^address/i, /^city$/i, /^zip$/i, /^postal/i, /^state$/i,
  /^note$/i, /^notes$/i, /^description$/i, /^summary$/i,
  /^body$/i,        
];

export const CREDENTIAL_FIELD_PATTERNS: readonly RegExp[] = [
  /secret/i,                 
  /token/i,                  
  /api[-_]?key/i,
  /authorization/i,
  /password/i, /passwd/i,
  /credential/i,
  /bearer/i,
  /cookie/i,
  /session[-_]?id/i,
  /sync[-_]?key/i,
  /client[-_]?secret/i,
  /refresh[-_]?token/i,
  /access[-_]?token/i,
  /jwt/i,
  /signature/i,
  /private[-_]?key/i,
  /^salt$/i,
];

const REDACT_FIELD_PATTERNS: readonly RegExp[] = [
  ...PII_FIELD_PATTERNS,
  ...CREDENTIAL_FIELD_PATTERNS,
];

function shouldRedactKey(key: string): boolean {
  for (const re of REDACT_FIELD_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedactKey(k)) {
      if (typeof v === 'string') {
        out[k] = `[redacted:str:${v.length}]`;
      } else if (typeof v === 'number') {
        out[k] = '[redacted:num]';
      } else if (v === null) {
        out[k] = null;
      } else {
        out[k] = '[redacted]';
      }
    } else {
      out[k] = redactPayload(v, depth + 1);
    }
  }
  return out;
}

function deriveAnnotations(tool: ToolDef): {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const method = tool.stEndpoint?.method ?? 'GET';
  return {
    title: tool.title ?? tool.name.replace(/_/g, ' '),
    readOnlyHint: !tool.isWrite,
    destructiveHint: tool.isWrite ? method !== 'POST' : false,
    idempotentHint: tool.isWrite ? ['PUT', 'DELETE'].includes(method) : true,
    openWorldHint: false,
  };
}

export function mergedAnnotations(tool: ToolDef): {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  return { ...deriveAnnotations(tool), ...(tool.annotations ?? {}) };
}

interface WireToolLike {
  name?: string;
  annotations?: { readOnlyHint?: unknown; [key: string]: unknown } | null;
}

export function isSweepEligible(tool: WireToolLike | null | undefined): boolean {
  return tool?.annotations?.readOnlyHint === true;
}

export function registerTool(
  server: McpServer,
  tool: ToolDef,
  env: Env,
  execCtx: ExecutionContext,
  reqCtx: RequestContext
): void {

  if (typeof tool.isWrite !== 'boolean' || !['staff','admin'].includes(tool.permission)) throw new Error(`Missing permission or mutation declaration: ${tool.name}`);
  if (reqCtx.allowedTools && !['st_operation_status', 'get_result_page'].includes(tool.name) && !reqCtx.allowedTools.includes(tool.name)) return;
  if ((tool.adminOnly || tool.permission === 'admin') && reqCtx.role !== 'admin') return;
  if (tool.isWrite && ['readonly','lockdown'].includes(reqCtx.role)) return;
  const annotations = mergedAnnotations(tool);

  server.registerTool(
    tool.name,
    {
      title: annotations.title,
      description: tool.description,
      inputSchema: tool.zodSchema,
      ...(tool.outputSchema ? { outputSchema: Object.assign(
        z.object(tool.outputSchema).partial().shape,
        { _offloaded: z.literal(true).optional(), _full: z.string().optional(), _bytes: z.number().optional(), _pages: z.number().optional() }
      ) } : {}),
      annotations,
      ...(tool.uiResourceUri ? { _meta: {
        ui: { resourceUri: tool.uiResourceUri, visibility: ['model', 'app'] },
        'ui/resourceUri': tool.uiResourceUri,
      } } : {}),
    },
    async (args: Record<string, unknown>, extra) => {
      const correlation = newCorrelationId();
      const started = Date.now();

      try {
        if (new TextEncoder().encode(JSON.stringify(args)).length > 131072) throw new McpError('validation_error', 'Tool arguments exceed the byte limit');
        const task = withBudget(env, scopeFor(env, reqCtx), tool.name === 'st_run_report' ? Math.min(600, Number(args.pollTimeoutSeconds) || 180) * 1000 : 180_000, async (scoped, budget) => {
          const invoke = () => tool.handler(scoped, args, { actor: reqCtx.actor, correlation, principal: reqCtx.principal, role: reqCtx.role, availableTools: reqCtx.availableTools });
          try {
            const rawResult = tool.name === 'st_operation_status' ? await operationStatus(scoped, String(args.operation_id), scopeFor(env, reqCtx), reqCtx.role, reqCtx.allowedTools)
              : tool.name === 'get_result_page' ? await getResultPage(scoped, String(args.result_id), Number(args.cursor ?? 0), reqCtx)
              : tool.isWrite && args.dryRun === false
              ? await recoverableWrite(scoped, tool.name, args, scopeFor(env, reqCtx), reqCtx.role, invoke)
              : await invoke();
            const result = scrubDiagnostics(scoped, tool.transformResult ? tool.transformResult(rawResult) : rawResult);
            if (tool.outputSchema) z.object(tool.outputSchema).parse(result);
            const shaped = await stage('serialization', () => offloadIfLarge(scoped, correlation, result, Boolean(tool.outputSchema), reqCtx, tool.name));
            budget.stages.response_bytes = new TextEncoder().encode(JSON.stringify(shaped)).length;
            return { result, shaped };
          } finally {
            try { env.MCP_METRICS?.writeDataPoint({ blobs: [tool.name, 'stages'], doubles: [budget.upstream, budget.stages.upstream ?? 0, budget.stages.response_read ?? 0, budget.stages.quota ?? 0, budget.stages.cache ?? 0, budget.stages.serialization ?? 0, budget.stages.coalesced ?? 0, budget.stages.database ?? 0, budget.stages.cache_hit ?? 0, budget.stages.cache_miss ?? 0, budget.stages.response_bytes ?? 0], indexes: [tool.name] }); } catch {  }
          }
        }, tool.isWrite && args.dryRun === false ? undefined : extra?.signal && reqCtx.signal ? AbortSignal.any([extra.signal, reqCtx.signal]) : extra?.signal ?? reqCtx.signal);
        if (tool.isWrite && args.dryRun === false) execCtx.waitUntil(task.then(() => {}, () => {}));
        const completed = await task;
        const result = completed.result;
        const latency = Date.now() - started;

        const isPartial =
          result !== null &&
          typeof result === 'object' &&
          (result as { _partial?: unknown })._partial === true;
        const failures = isPartial
          ? (result as { _failures?: unknown })._failures
          : undefined;
        const operationState = (result as { state?: string } | null)?.state;
        const outcome: obs.AuditRow['status'] = isPartial ? 'partial'
          : operationState === 'outcome-unknown' ? 'outcome_unknown'
          : operationState === 'failed-before-write' ? 'error'
          : operationState === 'running' || operationState === 'accepted' || operationState === 'verified' ? operationState : 'ok';

        execCtx.waitUntil(
          obs.audit(env, {
            actor: reqCtx.actor,
            surface: 'servicetitan',
            operation: tool.name,
            status: outcome,
            latency_ms: latency,
            correlation,
            payload: redactPayload(args),
          })
        );
        if (isPartial) {
          execCtx.waitUntil(
            obs.error(env, {
              source: `worker:servicetitan-mcp-server:${tool.name}`,
              severity: 'warn',
              message: `composite ${tool.name} returned partial result`,
              context: { actor: reqCtx.actor, correlation, failures },
              correlation,
            })
          );
        }
        execCtx.waitUntil(
          obs.heartbeat(env, `servicetitan-mcp-server:${tool.name}`, { ok: true })
        );
        emitMetric(env, execCtx, tool.name, outcome, latency, reqCtx);

        execCtx.waitUntil(
          traceTool(
            env,
            tool.name,
            reqCtx.actor,
            { correlation, role: reqCtx.role, actor: reqCtx.actor, partial: isPartial },
            async () => ({ status: isPartial ? 'error' : 'ok', latencyMs: latency })
          )
        );

        
        const shaped = completed.shaped;
        return { content: shaped.content, structuredContent: shaped.structuredContent };
      } catch (err) {
        const latency = Date.now() - started;
        const mcpErr = safeError(env, err, correlation);

        execCtx.waitUntil(
          obs.error(env, {
            source: `worker:servicetitan-mcp-server:${tool.name}`,
            severity: mcpErr.code === 'upstream_error' || mcpErr.code === 'config_error' ? 'error' : 'warn',
            message: mcpErr.message,
            stack: undefined,
            context: obs.safeContext({ actor: reqCtx.actor, correlation, code: mcpErr.code }),
            correlation,
          })
        );
        execCtx.waitUntil(
          obs.audit(env, {
            actor: reqCtx.actor,
            surface: 'servicetitan',
            operation: tool.name,
            status: mcpErr.code === 'validation_error' ? 'rejected' : mcpErr.code === 'rate_limited' ? 'rate_limited' : mcpErr.code === 'verify_unavailable' ? 'outcome_unknown' : 'error',
            latency_ms: latency,
            correlation,
            payload: redactPayload(args),
            result: { code: mcpErr.code, message: mcpErr.message },
          })
        );
        execCtx.waitUntil(
          obs.heartbeat(env, `servicetitan-mcp-server:${tool.name}`, { ok: false })
        );
        emitMetric(env, execCtx, tool.name, 'error', latency, reqCtx);

        execCtx.waitUntil(
          traceTool(
            env,
            tool.name,
            reqCtx.actor,
            { correlation, role: reqCtx.role, actor: reqCtx.actor, code: mcpErr.code },
            async () => ({ status: 'error', latencyMs: latency })
          )
        );

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(mcpErr.toResponse()) }],
          isError: true,
        };
      }
    }
  );
}

function emitMetric(
  env: Env,
  execCtx: ExecutionContext,
  tool: string,
  status: string,
  latencyMs: number,
  reqCtx: RequestContext
): void {
  if (!env.MCP_METRICS) return;
  try {
    env.MCP_METRICS.writeDataPoint({
      blobs: [tool, status, reqCtx.role, reqCtx.actor],
      doubles: [latencyMs],
      indexes: [tool], 
    });
  } catch (e) {
    
    console.error('[metrics] writeDataPoint failed');
  }
}
