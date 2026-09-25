import { vi } from 'vitest';
import { makeStatefulDB } from '../../sales/__tests__/helpers';

export const CTX = { actor: 'vitest', correlation: 'test-corr' };

export interface BackendCall {
  kind: 'read' | 'write';
  endpoint: string;
  method: string;
  body?: unknown;
}

export function makeBackendEnv(
  respond: (call: BackendCall) => unknown | Response,
  extra: Record<string, unknown> = {},
): { env: any; calls: BackendCall[] } {
  const calls: BackendCall[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    let call: BackendCall;
    if (u.pathname === '/api/st/read') {
      call = {
        kind: 'read',
        endpoint: u.searchParams.get('endpoint') ?? '',
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
    } else if (u.pathname === '/api/st/write') {
      const b = JSON.parse(String(init?.body));
      call = { kind: 'write', endpoint: b.endpoint, method: b.method, body: b.payload };
    } else {
      throw new Error(`unexpected backend route ${u.pathname}`);
    }
    calls.push(call);
    const out = respond(call);
    return out instanceof Response
      ? out
      : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const env: any = {
    ST_TRANSPORT: { fetch },
    LEGACY_TEST_KEY: 'test-key',
    CONFIRMATION_SIGNING_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
    DB: makeStatefulDB(),
    STATE_KV: {},
    ...extra,
  };
  return { env, calls };
}

export function page<T>(data: T[], hasMore = false) {
  return { data, hasMore, page: 1, pageSize: data.length, totalCount: data.length };
}


export function path(call: BackendCall): string {
  return call.endpoint.split('?')[0];
}


export function query(call: BackendCall): URLSearchParams {
  return new URL(`https://st.invalid${call.endpoint}`).searchParams;
}
