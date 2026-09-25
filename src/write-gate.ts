import type { Env } from './env';
import { currentBudget } from './request-budget';
import { rewriteTenantPlaceholders } from './tenant';
import { McpError } from './errors';

export function resolveSigningKey(env: { CONFIRMATION_SIGNING_KEY?: string }): string {
  const key = env.CONFIRMATION_SIGNING_KEY;
  if (!key) {
    throw new McpError('config_error', 'CONFIRMATION_SIGNING_KEY is not configured; set it with: wrangler secret put CONFIRMATION_SIGNING_KEY');
  }
  return key;
}

export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
export const MAX_TOKEN_TTL_MS = 15 * 60 * 1000;


export const TOKEN_TTL_MS = DEFAULT_TOKEN_TTL_MS;

async function hmacSign(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacVerify(key: string, message: string, expected: string): Promise<boolean> {
  const actual = await hmacSign(key, message);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const v = obj[key];
      if (v === undefined) return acc;
      acc[key] = canonicalize(v);
      return acc;
    }, {});
}

export async function hashArgs(args: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(canonicalize(args));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface DryRunResult {
  dryRun: true;
  tool: string;
  payload: unknown;
  st_endpoint: string;
  st_method: string;
  confirmation_token: string;
  expires_in_seconds: number;
}

export class WriteGate {
  constructor(private env: Env) {}

  async dryRun(
    tool: string,
    args: Record<string, unknown>,
    actor: string,
    correlation: string,
    payload: unknown,
    stEndpoint: string,
    stMethod: string,
    tokenTtlMs?: number
  ): Promise<DryRunResult> {
    const ttlMs = Math.min(tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS);
    const argsHash = await hashArgs(args);
    const issuedAt = Date.now();
    
    const safeActor = actor.replace(/\|/g, '%7C');
    const tokenMessage = `${tool}|${argsHash}|${safeActor}|${issuedAt}`;
    const tokenHmac = await hmacSign(resolveSigningKey(this.env), tokenMessage);
    const token = `${tokenMessage}|${tokenHmac}`;
    const tokenHash = await hashArgs({ token });

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO confirmation_tokens (token_hash, tool, args_hash, actor, issued_at, expires_at, correlation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(tokenHash, tool, argsHash, actor, issuedAt, issuedAt + ttlMs, correlation).run();
    const scope = currentBudget()?.scope;
    if (scope) await this.env.DB.prepare('INSERT OR IGNORE INTO mcp_confirmation_owners (token_hash, owner) VALUES (?, ?)').bind(tokenHash, scope).run();

    return {
      dryRun: true,
      tool,
      payload,
      st_endpoint: rewriteTenantPlaceholders(this.env, stEndpoint),
      st_method: stMethod,
      confirmation_token: token,
      expires_in_seconds: ttlMs / 1000,
    };
  }

  async verifyToken(
    tool: string,
    args: Record<string, unknown>,
    actor: string,
    confirmation_token: string
  ): Promise<void> {
    if (this.env.READONLY === '1') throw new Error('ST writes are blocked: this environment is read-only');
    const parts = confirmation_token.split('|');
    if (parts.length !== 5) throw new Error('malformed confirmation_token');
    const [tokenTool, argsHash, tokenActor, issuedAtStr, tokenHmac] = parts;
    const issuedAt = parseInt(issuedAtStr, 10);
    const safeActor = actor.replace(/\|/g, '%7C');

    if (tokenTool !== tool) throw new Error('confirmation_token is for a different tool');
    if (tokenActor !== safeActor) throw new Error('confirmation_token actor mismatch');

    if (Date.now() - issuedAt > MAX_TOKEN_TTL_MS) throw new Error('confirmation_token expired');

    const message = `${tokenTool}|${argsHash}|${tokenActor}|${issuedAtStr}`;
    const valid = await hmacVerify(resolveSigningKey(this.env), message, tokenHmac)
      || Boolean(this.env.CONFIRMATION_PREVIOUS_KEY && await hmacVerify(this.env.CONFIRMATION_PREVIOUS_KEY, message, tokenHmac));
    if (!valid) throw new Error('confirmation_token signature invalid');

    const currentArgsHash = await hashArgs(args);
    if (currentArgsHash !== argsHash) throw new Error('args changed since dryRun — re-run dryRun with current args');

    const tokenHash = await hashArgs({ token: confirmation_token });
    const scope = currentBudget()?.scope;
    if (scope) {
      const ownership = await this.env.DB.prepare('SELECT owner FROM mcp_confirmation_owners WHERE token_hash = ?').bind(tokenHash).first<{owner:string}>();
      
      if (ownership ? ownership.owner !== scope : !scope.includes('legacy-shared-client')) throw new Error('confirmation_token identity mismatch');
    }
    const row = await this.env.DB.prepare(
      'SELECT consumed_at, expires_at FROM confirmation_tokens WHERE token_hash = ? AND tool = ?'
    ).bind(tokenHash, tool).first<{ consumed_at: number | null; expires_at: number }>();

    if (!row) throw new Error('confirmation_token not found — it may have expired from D1');
    if (row.consumed_at) throw new Error('confirmation_token already used');

    if (Date.now() > row.expires_at) throw new Error('confirmation_token expired (per-tool TTL)');

    const consumed = await this.env.DB.prepare(
      'UPDATE confirmation_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL'
    ).bind(Date.now(), tokenHash).run();
    if (consumed.meta?.changes !== 1) {
      throw new Error('confirmation_token already used');
    }
  }
}
