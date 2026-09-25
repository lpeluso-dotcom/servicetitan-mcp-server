import type { Env } from './env';

export type Role = 'admin' | 'default' | 'lockdown' | 'readonly';

export interface AuthResult {
  authenticated: boolean;
  role: Role;
  actor: string;
  principal?: string;
  authMode: 'mcp-token' | 'none';
}

export function hasConfiguredSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length > 0 && secret !== 'undefined';
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = (await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])) as CryptoKey;
  const [ma, mb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const va = new Uint8Array(ma);
  const vb = new Uint8Array(mb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export function authHeaders(env: Env, correlation: string, actor: string): Record<string, string> {
  return {
    'X-Correlation-Id': correlation,
    'X-Actor': actor,
    'User-Agent': `servicetitan-mcp-server/${env.MCP_SERVICE_VERSION}`,
  };
}

const ACTOR_RE = /^[a-zA-Z0-9._:-]{1,64}$/;
export function safeActorHeader(raw: string | null): string {
  if (raw && ACTOR_RE.test(raw)) return raw;
  return 'claude-code';
}

export function newCorrelationId(): string {
  const ts = Date.now().toString(36);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${ts}-${rand}`;
}
