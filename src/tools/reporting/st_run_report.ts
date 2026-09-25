import { pause, currentBudget, checkDeadline } from '../../request-budget';
import { hashArgs } from '../../write-gate';
import { z } from 'zod';
import { McpError, mapUpstreamStatus } from '../../errors';
import { readST } from '../../st';
import { cacheGet } from '../../cache';
import { authHeaders } from '../../auth';
import { rewriteTenantPlaceholders } from '../../tenant';
import { guardedStFetch, parseRetryAfterSeconds } from '../../rate-limit-guard';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';
import { backendRead, backendWrite } from '../../backend';
import { reportRunIdentity, type ReportParam } from './report-identity';

export { reportRunIdentity };


export const REPORT_CACHE_NS = 'servicetitan:report_run';
export const REPORT_RUN_TTL_SEC = 300; 


const POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 180;

let reportRunCooldownUntil = 0;


export function _resetReportCooldown(): void {
  reportRunCooldownUntil = 0;
}

const ReportMode = z.enum(['list_categories', 'list_reports', 'describe_report', 'run']);

interface Args {
  mode: z.infer<typeof ReportMode>;
  categoryId?: string | number;
  reportId?: string | number;
  parameters?: ReportParam[];
  page?: number;
  pageSize?: number;
  pollTimeoutSeconds?: number;
  
  _pollIntervalMs?: number;
  
  _now?: () => number;
}

const PER_FETCH_TIMEOUT_MS = 30_000;
function fetchTimeoutSignal(remainingMs: number): AbortSignal {
  const ms = Math.max(1, Math.min(PER_FETCH_TIMEOUT_MS, remainingMs));
  return AbortSignal.timeout(ms);
}


function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}


function extractQueryToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of ['token', 'queryToken', 'id']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

async function cancelDataQuery(
  env: Env,
  ctx: { actor: string; correlation: string },
  token: string,
): Promise<void> {
  try {
    const endpoint = rewriteTenantPlaceholders(env, `/reporting/v2/tenant/000000000/data-queries/${encodeURIComponent(token)}`);
    await backendWrite(env, { endpoint, method: 'DELETE', payload: {} }, {
      headers: { ...authHeaders(env, ctx.correlation, ctx.actor), 'content-type': 'application/json' },
      
      signal: fetchTimeoutSignal(PER_FETCH_TIMEOUT_MS),
    });
  } catch {
    
  }
}

async function pollDataQuery(
  env: Env,
  ctx: { actor: string; correlation: string },
  token: string,
  pollTimeoutSeconds: number,
  opts: { pollIntervalMs?: number; now?: () => number },
): Promise<unknown> {
  const now = opts.now ?? Date.now;
  const sleepMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const start = now();
  const deadline = Math.min(start + pollTimeoutSeconds * 1000, currentBudget()?.deadline ?? Infinity);
  const pollPath = rewriteTenantPlaceholders(env, `/reporting/v2/tenant/000000000/data-queries/${encodeURIComponent(token)}`);

  let attempt = 0;
  while (now() < deadline) {
    if (attempt > 0 && sleepMs > 0) await pause(Math.min(sleepMs, Math.max(0, deadline - now())));
    if (now() >= deadline) break; 
    attempt++;

    let resp: Response;
    try {

      resp = await guardedStFetch(env, pollPath, () => backendRead(env, pollPath, {
        headers: authHeaders(env, ctx.correlation, ctx.actor),
        signal: fetchTimeoutSignal(deadline - now()),
      }));
    } catch (err) {
      if (isAbortError(err)) break; 
      throw err;
    }

    if (resp.status === 200) {
      return await resp.json();
    }
    if (resp.status === 202) {
      continue;
    }

    
    throw new McpError(
      mapUpstreamStatus(resp.status),
      `report query poll failed: upstream returned ${resp.status} (correlation ${ctx.correlation})`,
      { correlation: ctx.correlation },
    );
  }

  await cancelDataQuery(env, ctx, token);
  const elapsedSeconds = Math.round((now() - start) / 1000);
  throw new McpError(
    'timeout',
    `report query ${token} timed out after ${elapsedSeconds}s (ceiling ${pollTimeoutSeconds}s) — cancellation attempted; completion remains unverified`,
    { correlation: ctx.correlation },
  );
}

export async function runReportQueryAsync(
  env: Env,
  ctx: { actor: string; correlation: string },
  categoryId: string | number,
  reportId: string | number,
  runBody: Record<string, unknown>,
  pollTimeoutSeconds: number,
  opts: { identity: string; pollIntervalMs?: number; now?: () => number },
): Promise<unknown> {
  const scope = currentBudget()?.scope;
  const queryKey = scope ? await hashArgs({ scope, identity: opts.identity }) : undefined;
  if (queryKey) {
    const previous = await env.DB.prepare('SELECT token, result, updated_at FROM mcp_report_queries WHERE k = ?').bind(queryKey).first<{token:string|null;result:string|null;updated_at:number}>();
    if (previous && Date.now() - previous.updated_at < 650_000) {
      if (previous.result) return JSON.parse(previous.result);
      if (previous.token) return pollDataQuery(env, ctx, previous.token, pollTimeoutSeconds, {pollIntervalMs:opts.pollIntervalMs,now:opts.now});
      throw new McpError('rate_limited', 'Previous report submission has no confirmed query token; do not start a duplicate', {retry_after_ms:REPORT_RUN_TTL_SEC*1000});
    }
    const claim = await env.DB.prepare(`INSERT INTO mcp_report_queries (k, updated_at) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET token=NULL,result=NULL,updated_at=excluded.updated_at WHERE mcp_report_queries.updated_at < ?`)
      .bind(queryKey,Date.now(),Date.now()-650_000).run();
    if (claim.meta?.changes !== 1) throw new McpError('rate_limited','Identical report submission already claimed',{retry_after_ms:1000});
  }
  const queryPath = rewriteTenantPlaceholders(
    env,
    `/reporting/v2/tenant/000000000/report-category/${categoryId}/reports/${reportId}/data/query?page=${runBody.page ?? 1}&pageSize=${runBody.pageSize ?? 100}`,
  );

  let initialResp: Response;
  try {
    initialResp = await guardedStFetch(
      env,
      queryPath,
      () =>
        backendRead(env, queryPath, {
          method: 'POST',
          headers: { ...authHeaders(env, ctx.correlation, ctx.actor), 'content-type': 'application/json' },
          body: JSON.stringify({ parameters: runBody.parameters }),
          
          signal: fetchTimeoutSignal(pollTimeoutSeconds * 1000),
        }),
      { identity: opts.identity },
    );
  } catch (err) {
    if (isAbortError(err)) {
      throw new McpError(
        'timeout',
        `report data/query POST did not respond within ${pollTimeoutSeconds}s (correlation ${ctx.correlation})`,
        { correlation: ctx.correlation },
      );
    }
    throw err;
  }

  if (initialResp.status === 200) {
    const result = await initialResp.json();
    if (queryKey) await env.DB.prepare('UPDATE mcp_report_queries SET result = ? WHERE k = ?').bind(JSON.stringify(result),queryKey).run();
    return result;
  }

  if (initialResp.status !== 202) {
    if (initialResp.status === 429) {
      throw new McpError(
        'rate_limited',
        `report data/query rate-limited by ServiceTitan (correlation ${ctx.correlation})`,
        {
          correlation: ctx.correlation,
          retry_after_ms: parseRetryAfterSeconds(initialResp.headers.get('Retry-After')) * 1000,
        },
      );
    }
    
    throw new McpError(
      mapUpstreamStatus(initialResp.status),
      `report data/query POST failed: upstream returned ${initialResp.status} (correlation ${ctx.correlation})`,
      { correlation: ctx.correlation },
    );
  }

  const body202 = await initialResp.json().catch(() => ({}));
  const token = extractQueryToken(body202);
  if (!token) {
    const keys = body202 && typeof body202 === 'object' ? Object.keys(body202 as object) : [];
    throw new McpError(
      'upstream_error',
      `report data/query returned 202 (still running) but no usable token field — checked token, queryToken, id, found none. Response did not match the supported token contract.`,
      { correlation: ctx.correlation },
    );
  }
  if (queryKey) await env.DB.prepare('UPDATE mcp_report_queries SET token = ? WHERE k = ?').bind(token,queryKey).run();

  return await pollDataQuery(env, ctx, token, pollTimeoutSeconds, {
    pollIntervalMs: opts.pollIntervalMs,
    now: opts.now,
  });
}

export const st_run_report: ToolDef<Args> = {
  isWrite: false,
  permission: "staff",
  name: 'st_run_report',
  description:
    'Run or discover ServiceTitan native reports. Modes: list_categories | list_reports (requires categoryId) | describe_report (requires categoryId + reportId — MANDATORY before first run on unknown reportId; parameter schema is dynamic) | run (requires categoryId + reportId, takes parameters[]). ' +
    'run is ASYNC (the old synchronous POST .../data endpoint is deprecated and no longer called): Fast reports return rows inline; slow ones are polled. This legacy convenience mode polls to a bounded ceiling (default 180s; max 240). For reports that may outlive one client request, use st_report_start -> st_report_status -> st_report_results; they never duplicate a pending submission. Source: live ST.',
  zodSchema: {
    mode: ReportMode.describe('Reporting workflow step'),
    categoryId: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Report category ID — required for list_reports/describe_report/run'),
    reportId: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Report ID — required for describe_report/run'),
    parameters: z
      .array(z.object({ name: z.string(), value: z.unknown() }))
      .optional()
      .describe('Parameter list for mode=run; shape per describe_report response'),
    page: z.number().int().positive().optional().describe('Page (run mode only, default 1)'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .describe('Page size (run mode only, default 100)'),
    pollTimeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(240)
      .optional()
      .describe(
        'mode=run only. Wall-clock ceiling for the legacy polling path. Default 180, max 240. Use the resumable report tools for longer work.',
      ),
  },
  stEndpoint: {
    method: 'POST',
    path: '/reporting/v2/tenant/{tid}/report-category/{cat}/reports/{reportId}/data/query',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {

    const requireArg: (cond: unknown, msg: string) => asserts cond = (cond, msg) => {
      if (!cond) {
        throw new McpError('validation_error', msg, { correlation });
      }
    };
    const tid = '000000000';

    if (args.mode === 'list_categories') {
      const data = await readST<{ data?: unknown[] }>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-categories`,
      );
      return { mode: 'list_categories', categories: data.data ?? data, _source: 'live' };
    }

    if (args.mode === 'list_reports') {
      requireArg(args.categoryId !== undefined, 'categoryId required for mode=list_reports');
      const data = await readST<{ data?: unknown[] }>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports`,
      );
      return {
        mode: 'list_reports',
        categoryId: args.categoryId,
        reports: data.data ?? data,
        _source: 'live',
      };
    }

    if (args.mode === 'describe_report') {
      requireArg(args.categoryId !== undefined, 'categoryId required for mode=describe_report');
      requireArg(args.reportId !== undefined, 'reportId required for mode=describe_report');
      const data = await readST<unknown>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports/${args.reportId}`,
      );
      return {
        mode: 'describe_report',
        categoryId: args.categoryId,
        reportId: args.reportId,
        report: data,
        _source: 'live',
      };
    }

    
    requireArg(args.categoryId !== undefined, 'categoryId required for mode=run');
    requireArg(args.reportId !== undefined, 'reportId required for mode=run');
    requireArg(
      Array.isArray(args.parameters),
      'parameters[] required for mode=run (use describe_report to discover the schema)',
    );

    const runBody: Record<string, unknown> = {
      parameters: args.parameters,
      pageSize: args.pageSize ?? 100,
      page: args.page ?? 1,
    };
    const now = args._now ?? Date.now;

    const identity = reportRunIdentity({
      categoryId: args.categoryId,
      reportId: args.reportId,
      parameters: args.parameters,
      page: runBody.page,
      pageSize: runBody.pageSize,
    });

    let hitUpstream = false;
    let data: unknown;
    try {
      data = await cacheGet<unknown>(env, REPORT_CACHE_NS, identity, REPORT_RUN_TTL_SEC, async () => {
    const nowMs = now();
    if (reportRunCooldownUntil > nowMs) {
      const remainingMs = reportRunCooldownUntil - nowMs;
      throw new McpError(
        'rate_limited',
        `st_run_report: ServiceTitan's reporting API returned 429 recently; mode=run is in a ` +
          `${Math.ceil(remainingMs / 1000)}s cooldown. Retry after that, or re-run a report you already ` +
          `pulled in the last ${REPORT_RUN_TTL_SEC / 60} minutes (it is served from cache and costs nothing).`,
        { correlation, retry_after_ms: remainingMs },
      );
    }

        hitUpstream = true;
        checkDeadline();
        return runReportQueryAsync(
          env,
          { actor, correlation },
          args.categoryId!,
          args.reportId!,
          runBody,
          args.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
          { identity, pollIntervalMs: args._pollIntervalMs, now: args._now },
        );
      });
    } catch (err) {

      if (
        err instanceof McpError &&
        err.code === 'rate_limited' &&
        (err.details as { reason?: string } | undefined)?.reason !== 'same_report_within_window'
      ) {
        reportRunCooldownUntil = now() + (err.retry_after_ms ?? 60_000);
      }
      throw err;
    }

    return {
      mode: 'run',
      categoryId: args.categoryId,
      reportId: args.reportId,
      data,
      _source: hitUpstream ? 'live' : 'cache',
      ...(hitUpstream ? {} : { _cache_ttl_seconds: REPORT_RUN_TTL_SEC }),
    };
  },
  transformResult: defaultShaper,
};
