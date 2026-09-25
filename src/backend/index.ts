import type { BackendEnv, StBackendName } from './env';
import { createDirectBackend } from './direct';
import { McpError } from '../errors';

export type { BackendEnv, StBackendName } from './env';

export const ST_BACKEND_ORIGIN = 'https://st-backend.invalid';

type TransportEnv = BackendEnv & { ST_TENANT_ID?: string };

export interface BackendInit {
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface StWriteBody {
  endpoint: string;
  method: string;
  payload: unknown;
}

export function proxyReadUrl(endpoint: string): string {
  return `${ST_BACKEND_ORIGIN}/api/st/read?endpoint=${encodeURIComponent(endpoint)}`;
}

export function backendName(env: Pick<BackendEnv, 'ST_BACKEND'>): StBackendName {
  const raw = (env.ST_BACKEND ?? '').trim();
  if (raw === '' || raw === 'direct') return 'direct';
  
  
  throw new McpError('config_error', `ST_BACKEND must be 'direct' (or unset) (got "${raw}")`);
}

const directByEnv = new WeakMap<object, Fetcher>();

export function stTransport(env: TransportEnv): Fetcher {
  if (env.ST_TRANSPORT) return env.ST_TRANSPORT;
  backendName(env);
  let direct = directByEnv.get(env);
  if (!direct) {
    direct = createDirectBackend(env);
    directByEnv.set(env, direct);
  }
  return direct;
}

export function backendRead(env: TransportEnv, endpoint: string, init: RequestInit): Promise<Response> {
  return stTransport(env).fetch(proxyReadUrl(endpoint), init);
}

export function backendWrite(env: TransportEnv, body: StWriteBody, init: BackendInit): Promise<Response> {
  return stTransport(env).fetch(`${ST_BACKEND_ORIGIN}/api/st/write`, {
    method: 'POST',
    headers: init.headers,
    body: JSON.stringify(body),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}


export function backendBindingChecks(env: BackendEnv): Record<string, boolean> {
  try {
    backendName(env);
  } catch {
    return { 'config:ST_BACKEND': false };
  }
  return {
    'secret:ST_CLIENT_ID': Boolean(env.ST_CLIENT_ID),
    'secret:ST_CLIENT_SECRET': Boolean(env.ST_CLIENT_SECRET),
    'secret:ST_APP_KEY': Boolean(env.ST_APP_KEY),
  };
}
