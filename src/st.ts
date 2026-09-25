import type { Env } from './env';
import { authHeaders } from './auth';
import { McpError, mapUpstreamStatus } from './errors';
import { guardedStFetch, parseRetryAfterSeconds } from './rate-limit-guard';
import { rewriteTenantPlaceholders } from './tenant';
import { backendRead } from './backend';

export interface ReadSTContext {
  actor: string;
  correlation: string;
}

export function rejectUnsupportedSTFilters(
  args: Record<string, unknown>,
  unsupported: Record<string, string>,
  correlation?: string,
): void {
  const offenders = Object.keys(unsupported).filter(
    (k) => args[k] !== undefined && args[k] !== null && args[k] !== '',
  );
  if (offenders.length === 0) return;
  const detail = offenders.map((k) => `\`${k}\`: ${unsupported[k]}`).join(' ');
  throw new McpError(
    'validation_error',
    `ServiceTitan does not support filtering by ${offenders.map((k) => `\`${k}\``).join(', ')} ` +
      `on this endpoint — it ignores the parameter and returns an unfiltered first page, ` +
      `which would look like a real match. Refusing rather than returning wrong data. ${detail}`,
    { correlation },
  );
}

export interface STListResponse<T = unknown> {
  data: T[];
  hasMore?: boolean;
  page?: number;
  pageSize?: number;
  totalCount?: number;
}


function buildEndpoint(endpoint: string, query?: Record<string, unknown>): string {
  let path = endpoint;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) path = path.includes('?') ? `${path}&${qsStr}` : `${path}?${qsStr}`;
  }
  return path;
}

export async function readST<T = unknown>(
  env: Env,
  ctx: ReadSTContext,
  endpoint: string,
  query?: Record<string, unknown>,
): Promise<T> {

  const resolved = rewriteTenantPlaceholders(env, endpoint);
  const endpointWithQuery = buildEndpoint(resolved, query);

  const resp = await guardedStFetch(env, resolved, () =>
    backendRead(env, endpointWithQuery, {
      headers: authHeaders(env, ctx.correlation, ctx.actor),
    }),
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(resp.status),

      `readST ${resp.status} on ${resolved}: ${body.slice(0, 600)}`,
      {
        correlation: ctx.correlation,
        
        ...(resp.status === 429
          ? { retry_after_ms: parseRetryAfterSeconds(resp.headers.get('Retry-After')) * 1000 }
          : {}),
      },
    );
  }
  return (await resp.json()) as T;
}

export async function readSTPost<T = unknown>(
  env: Env,
  ctx: ReadSTContext,
  endpoint: string,
  body: unknown,

  opts: { identity?: string } = {},
): Promise<T> {
  const resolved = rewriteTenantPlaceholders(env, endpoint);
  const endpointWithQuery = buildEndpoint(resolved);
  
  
  const resp = await guardedStFetch(
    env,
    resolved,
    () =>
      backendRead(env, endpointWithQuery, {
        method: 'POST',
        headers: { ...authHeaders(env, ctx.correlation, ctx.actor), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    opts,
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(resp.status),
      `readSTPost ${resp.status} on ${resolved}: ${text.slice(0, 200)}`,
      {
        correlation: ctx.correlation,
        ...(resp.status === 429
          ? { retry_after_ms: parseRetryAfterSeconds(resp.headers.get('Retry-After')) * 1000 }
          : {}),
      },
    );
  }
  return (await resp.json()) as T;
}

export interface ReadSTPagedOptions {
  
  maxPages?: number;
  
  pageSize?: number;
  
  startPage?: number;
}

export interface ReadSTPagedResult<T = unknown> {
  rows: T[];
  pagesFetched: number;
  hitCap: boolean;
  totalCount: number | null;
}

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 50;

export async function readSTPaged<T = unknown>(
  env: Env,
  ctx: ReadSTContext,
  endpoint: string,
  query: Record<string, unknown> = {},
  options: ReadSTPagedOptions = {},
): Promise<ReadSTPagedResult<T>> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  let page = options.startPage ?? 1;
  const rows: T[] = [];
  let hitCap = false;
  let totalCount: number | null = null;

  for (let i = 0; i < maxPages; i++) {
    const body = await readST<STListResponse<T>>(env, ctx, endpoint, {
      ...query,
      page,
      pageSize,
    });
    rows.push(...(body.data ?? []));
    if (body.totalCount !== undefined) totalCount = body.totalCount;
    if (!body.hasMore) {
      return { rows, pagesFetched: i + 1, hitCap: false, totalCount };
    }
    page += 1;
  }
  hitCap = true;
  return { rows, pagesFetched: maxPages, hitCap, totalCount };
}
