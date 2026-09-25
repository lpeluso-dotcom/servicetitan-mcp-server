import type { BackendEnv } from './env';
import { McpError } from '../errors';

export const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TTL_SEC = 900;

const DEFAULT_MINT_TIMEOUT_MS = 10_000;
let mintTimeoutMs = DEFAULT_MINT_TIMEOUT_MS;

interface CachedToken {
  token: string;
  expiresAt: number;
  key: string;
}

let cached: CachedToken | null = null;
let inflight: { key: string; promise: Promise<string> } | null = null;

type TokenEnv = Pick<BackendEnv, 'ST_ENV' | 'ST_CLIENT_ID' | 'ST_CLIENT_SECRET'>;

export function stAuthBase(env: Pick<BackendEnv, 'ST_ENV'>): string {
  return env.ST_ENV === 'integration'
    ? 'https://auth-integration.servicetitan.io'
    : 'https://auth.servicetitan.io';
}

function requireSecret(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {

    throw new McpError('config_error', `${name} is not configured; set it with: wrangler secret put ${name}`);
  }
  return value;
}

async function mint(env: TokenEnv, key: string, clientId: string, clientSecret: string): Promise<string> {
  const resp = await fetch(`${stAuthBase(env)}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),

    signal: AbortSignal.timeout(mintTimeoutMs),
  });
  if (!resp.ok) {
    
    throw new McpError('upstream_error', `ServiceTitan OAuth token request failed: HTTP ${resp.status}`);
  }
  let data: { access_token?: unknown; expires_in?: unknown };
  try {
    
    data = (await resp.json()) as typeof data;
  } catch {
    throw new McpError('upstream_error', 'ServiceTitan OAuth token response was not valid JSON');
  }
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new McpError('upstream_error', 'ServiceTitan OAuth response did not include an access_token');
  }
  const ttlSec = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : DEFAULT_TTL_SEC;
  cached = { token: data.access_token, expiresAt: Date.now() + ttlSec * 1000, key };
  return cached.token;
}


export async function getStAccessToken(env: TokenEnv): Promise<string> {
  const clientId = requireSecret(env.ST_CLIENT_ID, 'ST_CLIENT_ID');
  const clientSecret = requireSecret(env.ST_CLIENT_SECRET, 'ST_CLIENT_SECRET');
  const key = `${stAuthBase(env)}|${clientId}`;
  if (cached && cached.key === key && Date.now() < cached.expiresAt - TOKEN_REFRESH_SKEW_MS) {
    return cached.token;
  }
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = mint(env, key, clientId, clientSecret);
  inflight = { key, promise };

  const clearInflight = (): void => {
    if (inflight?.promise === promise) inflight = null;
  };
  promise.then(clearInflight, clearInflight);
  return promise;
}


export function clearStTokenCache(): void {
  cached = null;
  inflight = null;
}


export function setMintTimeoutMsForTest(ms: number | null): void {
  mintTimeoutMs = ms ?? DEFAULT_MINT_TIMEOUT_MS;
}

export function invalidateStAccessToken(env: TokenEnv): void {
  const key = `${stAuthBase(env)}|${env.ST_CLIENT_ID}`;
  if (cached && cached.key === key) cached = null;
}
