import { vi } from 'vitest';

export const CTX = { actor: 'vitest', correlation: 'test-corr' };

interface TokenRow {
  token_hash: string;
  consumed_at: number | null;
  expires_at: number;
}

export function makeStatefulDB() {
  const tokens: Map<string, TokenRow> = new Map();
  return {
    tokens,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt = {
        bind: vi.fn(function (this: unknown, ...args: unknown[]) {
          captured.push(...args);
          return this;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR IGNORE INTO confirmation_tokens/i.test(sql)) {
            const tokenHash = String(captured[0]);
            const expiresAt = Number(captured[5]);
            tokens.set(tokenHash, { token_hash: tokenHash, consumed_at: null, expires_at: expiresAt });
          } else if (/UPDATE confirmation_tokens SET consumed_at/i.test(sql)) {
            const consumedAt = Number(captured[0]);
            const tokenHash = String(captured[1]);
            const row = tokens.get(tokenHash);
            if (row) row.consumed_at = consumedAt;
          }
          return { success: true, meta: { changes: 1 } };
        }),
        first: vi.fn(async () => {
          if (/SELECT consumed_at, expires_at FROM confirmation_tokens/i.test(sql)) {
            const tokenHash = String(captured[0]);
            return tokens.get(tokenHash) ?? null;
          }
          return null;
        }),
      };
      return stmt;
    }),
  };
}

export function makeEnv(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  db: ReturnType<typeof makeStatefulDB> = makeStatefulDB(),
  
): any {
  return {
    ST_TRANSPORT: { fetch: vi.fn(fetchImpl) },
    LEGACY_TEST_KEY: 'test-key',
    CONFIRMATION_SIGNING_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: db,
    STATE_KV: {},
  };
}

export function noFetch() {
  return async (url: string) => {
    throw new Error(`ST_TRANSPORT should not have been called on dryRun: ${url}`);
  };
}

export function liveOk(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

export function liveOkDirect(data: unknown) {
  return async () => new Response(JSON.stringify(data), { status: 200 });
}
