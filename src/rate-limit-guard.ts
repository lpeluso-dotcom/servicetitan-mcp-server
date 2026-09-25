import { checkDeadline, stage, currentBudget, pause, withQuotaPermit } from './request-budget';
import type { Env } from './env';
import { McpError } from './errors';

export const LIMITER_DO_NAME = 'st-global';


export const UNKNOWN_FAMILY = 'other';

export function familyFromEndpoint(endpoint: string): string {
  const m = endpoint.match(/^\/([a-z]+)\//);
  return m?.[1] ?? UNKNOWN_FAMILY;
}

function limiterBound(env: Env): boolean {
  const ns = (env as Partial<Env>)?.ST_RATE_LIMITER;
  return typeof (ns as { idFromName?: unknown } | undefined)?.idFromName === 'function';
}

function limiterStub(env: Env) {
  const id = env.ST_RATE_LIMITER.idFromName(LIMITER_DO_NAME);
  return env.ST_RATE_LIMITER.get(id);
}

export interface RateLimitOptions {

  identity?: string;
}


type DenyReason = 'aggregate' | 'family' | 'same_report_within_window';

interface CheckResponse {
  allowed: boolean;
  retryAfter?: number;
  retryAfterMs?: number;
  reason?: DenyReason;
}

export const MAX_PACE_WAIT_MS = 1_200;

export const MAX_PACE_ATTEMPTS = 3;

let pacingSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function _setPacingSleep(fn: (ms: number) => Promise<void>): (ms: number) => Promise<void> {
  const prev = pacingSleep;
  pacingSleep = fn;
  return prev;
}

function denyMessage(reason: DenyReason | undefined, family: string, retryAfter: number): string {
  if (reason === 'same_report_within_window') {
    return (
      `ST reporting limit: ServiceTitan allows 1 run of the same report per minute per tenant, ` +
      `and this exact report (same id AND same parameters) already ran inside that window. ` +
      `Retry after ${retryAfter}s, or re-read the cached result.`
    );
  }
  
  
  return `ST rate limit: retry after ${retryAfter}s (family: ${family})`;
}

export async function checkRateLimit(
  env: Env,
  family: string,
  opts: RateLimitOptions = {},
): Promise<void> {
  if (!limiterBound(env)) { if (currentBudget()) throw new McpError('rate_limited', 'Quota coordination unavailable'); return; }

  const body = JSON.stringify(
    
    
    opts.identity === undefined ? { family } : { family, identity: opts.identity },
  );

  for (let attempt = 0; ; attempt++) {
    let data: CheckResponse;
    try {
      const resp = await stage('quota', () => limiterStub(env).fetch('https://do/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: currentBudget()?.signal,
      }));
      data = await stage('quota', () => resp.json<CheckResponse>());
      if (!resp.ok || typeof data.allowed !== 'boolean') throw new Error('Invalid limiter response');
    } catch (e) {
      
      throw new McpError('rate_limited', 'Quota coordination unavailable; cached reads remain available', { retry_after_ms: 1000 });
    }

    if (data.allowed) return;

    const retryAfter = data.retryAfter ?? 60;
    const retryAfterMs = data.retryAfterMs ?? retryAfter * 1000;
    const paceable = data.reason !== 'same_report_within_window' && retryAfterMs <= MAX_PACE_WAIT_MS;

    if (paceable && attempt < MAX_PACE_ATTEMPTS) {
      
      
      await (currentBudget() ? pause : pacingSleep)(retryAfterMs + Math.floor(Math.random() * 25));
      continue;
    }

    throw new McpError('rate_limited', denyMessage(data.reason, family, retryAfter), {
      retry_after_ms: retryAfterMs,
      details: { family, retry_after_s: retryAfter, reason: data.reason ?? 'budget' },
    });
  }
}


export async function reportBackoff(env: Env, family: string, retryAfter: number): Promise<void> {
  if (!limiterBound(env)) { if (currentBudget()) throw new McpError('rate_limited', 'Quota coordination unavailable'); return; }
  try {
    await stage('quota', () => limiterStub(env).fetch('https://do/backoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ family, retryAfter }),
      signal: currentBudget()?.signal,
    }));
  } catch (e) {
    
    console.error('[rate-limit] backoff report failed');
  }
}

export function parseRetryAfterSeconds(header: string | null | undefined): number {
  const n = Number(header);
  if (header && Number.isFinite(n) && n >= 0) return Math.min(3600, Math.ceil(n));
  const date = Date.parse(header ?? '');
  return Number.isFinite(date) ? Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000))) : 60;
}

export async function guardedStFetch(
  env: Env,
  endpoint: string,
  run: () => Promise<Response>,
  opts: RateLimitOptions = {},
): Promise<Response> {
  return guardedFamilyFetch(env, familyFromEndpoint(endpoint), run, opts);
}

export async function guardedFamilyFetch(
  env: Env,
  family: string,
  run: () => Promise<Response>,
  opts: RateLimitOptions = {},
): Promise<Response> {
  checkDeadline();
  await checkRateLimit(env, family, opts);
  checkDeadline();
  const resp = await withQuotaPermit(run);
  if (resp.status === 429) {
    await reportBackoff(env, family, parseRetryAfterSeconds(resp.headers.get('Retry-After')));
  }
  return resp;
}

export function rateLimitedError(
  message: string,
  retryAfterSeconds: number,
  correlation?: string,
): McpError {
  return new McpError('rate_limited', message, {
    retry_after_ms: retryAfterSeconds * 1000,
    correlation,
  });
}
