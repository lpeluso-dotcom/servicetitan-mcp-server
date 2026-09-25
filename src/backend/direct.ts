import type { BackendEnv } from './env';
import { getStAccessToken, invalidateStAccessToken } from './st-oauth';
import { rewriteTenantPlaceholders, PUBLIC_TENANT_ID_PLACEHOLDER } from '../tenant';
import { McpError } from '../errors';

type DirectEnv = BackendEnv & { ST_TENANT_ID?: string };

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function stApiBase(env: Pick<BackendEnv, 'ST_ENV'>): string {
  return env.ST_ENV === 'integration' ? 'https://api-integration.servicetitan.io' : 'https://api.servicetitan.io';
}

export function stApiUrl(env: Pick<BackendEnv, 'ST_ENV'> & { ST_TENANT_ID?: string }, endpoint: string): URL | null {
  const tenantId = env.ST_TENANT_ID?.trim();
  if (!tenantId || tenantId === PUBLIC_TENANT_ID_PLACEHOLDER) {
    throw new McpError('config_error', 'ST_TENANT_ID is not configured; set it to your ServiceTitan tenant id');
  }
  if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('\\')) return null;
  const base = stApiBase(env);
  const url = new URL(rewriteTenantPlaceholders({ ST_TENANT_ID: env.ST_TENANT_ID ?? '' }, endpoint), base);
  return url.origin === base ? url : null;
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function stHeaders(env: DirectEnv, withBody: boolean): Promise<Record<string, string>> {
  const token = await getStAccessToken(env);
  const appKey = env.ST_APP_KEY;
  if (typeof appKey !== 'string' || appKey.trim() === '') {
    
    
    throw new McpError('config_error', 'ST_APP_KEY is not configured; set it with: wrangler secret put ST_APP_KEY');
  }
  return {
    Authorization: `Bearer ${token}`,
    'ST-App-Key': appKey,
    Accept: 'application/json',
    ...(withBody ? { 'content-type': 'application/json' } : {}),
  };
}

async function stFetch(env: DirectEnv, url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 401) invalidateStAccessToken(env);
  return res;
}

async function handleRead(env: DirectEnv, req: Request, url: URL): Promise<Response> {
  const endpoint = url.searchParams.get('endpoint');
  const target = endpoint ? stApiUrl(env, endpoint) : null;
  if (!target) return jsonError(400, 'bad_endpoint', 'endpoint must be a ServiceTitan API path starting with /');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonError(405, 'method_not_allowed', '/api/st/read accepts GET or POST');
  }
  const body = req.method === 'POST' ? await req.text() : undefined;
  return stFetch(env, target.toString(), {
    method: req.method,
    headers: await stHeaders(env, body !== undefined),
    ...(body !== undefined ? { body } : {}),
    signal: req.signal,
  });
}

async function wrapStWriteResponse(res: Response, endpoint: string, method: string): Promise<Response> {
  const text = await res.text();
  let response: unknown;
  try {
    response = JSON.parse(text);
  } catch {
    response = { raw: text };
  }
  const body = res.ok
    ? { success: true, endpoint, method, response }
    : { error: `ST API ${res.status}`, endpoint, method, response };
  return new Response(JSON.stringify(body), {
    status: res.ok ? 200 : res.status,
    headers: { 'content-type': 'application/json' },
  });
}

async function handleWrite(env: DirectEnv, req: Request): Promise<Response> {
  let parsed: { endpoint?: unknown; method?: unknown; payload?: unknown };
  try {
    parsed = (await req.json()) as typeof parsed;
  } catch {
    return jsonError(400, 'bad_body', '/api/st/write expects JSON {endpoint, method, payload}');
  }
  const method = typeof parsed.method === 'string' ? parsed.method.toUpperCase() : '';
  const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint : '';
  const target = endpoint ? stApiUrl(env, endpoint) : null;
  if (!target) return jsonError(400, 'bad_endpoint', 'endpoint must be a ServiceTitan API path starting with /');
  if (!WRITE_METHODS.has(method)) return jsonError(400, 'bad_body', 'method must be POST, PATCH, PUT, or DELETE');
  const hasBody = method !== 'DELETE' && parsed.payload !== undefined && parsed.payload !== null;
  const res = await stFetch(env, target.toString(), {
    method,
    headers: await stHeaders(env, hasBody),
    ...(hasBody ? { body: JSON.stringify(parsed.payload) } : {}),
    signal: req.signal,
  });
  return wrapStWriteResponse(res, endpoint, method);
}


export function createDirectBackend(env: DirectEnv): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = new Request(input instanceof URL ? input.toString() : input, init);
      const url = new URL(req.url);
      if (url.pathname === '/api/st/read') return handleRead(env, req, url);
      if (url.pathname === '/api/st/write') return handleWrite(env, req);
      return jsonError(404, 'unknown_route', `direct backend has no route ${url.pathname}`);
    },
    connect() {
      throw new Error('direct backend does not support connect()');
    },
  } as unknown as Fetcher;
}
