import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { toStPricebookPayload } from '../pricebook-payload';
import { st_patch_service } from '../st_patch_service';
import { st_create_service } from '../st_create_service';
import { st_patch_material } from '../st_patch_material';
import { st_create_material } from '../st_create_material';
import { PUBLIC_TOOLS } from '../public-registry';
import { filterToolsForRole } from '../role-filter';
import { registerTool } from '../../tool-registry';

const CTX = { actor: 'vitest', correlation: 'test-corr' };
const TENANT = '000000000';

interface TokenRow { token_hash: string; consumed_at: number | null; expires_at: number }

function makeStatefulDB() {
  const tokens: Map<string, TokenRow> = new Map();
  return {
    tokens,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt = {
        bind: vi.fn(function (this: any, ...args: unknown[]) {
          captured.push(...args);
          return this;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR IGNORE INTO confirmation_tokens/i.test(sql)) {
            const tokenHash = String(captured[0]);
            tokens.set(tokenHash, { token_hash: tokenHash, consumed_at: null, expires_at: Number(captured[5]) });
          } else if (/UPDATE confirmation_tokens SET consumed_at/i.test(sql)) {
            const row = tokens.get(String(captured[1]));
            if (row) row.consumed_at = Number(captured[0]);
          }
          return { success: true, meta: { changes: 1 } };
        }),
        first: vi.fn(async () => {
          if (/SELECT consumed_at, expires_at FROM confirmation_tokens/i.test(sql)) {
            return tokens.get(String(captured[0])) ?? null;
          }
          return null;
        }),
      };
      return stmt;
    }),
  };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, tenant: string | undefined = TENANT): any {
  return {
    ST_TRANSPORT: { fetch: vi.fn(fetchImpl) },
    ...(tenant ? { ST_TENANT_ID: tenant } : {}),
    CONFIRMATION_SIGNING_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeStatefulDB(),
    STATE_KV: {},
  };
}

const noCall = async () => { throw new Error('no ST call on dry run'); };

const isWriteUrl = (url: string) => url.endsWith('/api/st/write');

// A ServiceTitan stand-in with a stored record. Writes merge the payload into
// the record and answer with the real write envelope; reads return the record.
// `drop` lists fields ServiceTitan "silently drops" (200 but never stored).
function sim(opts: { drop?: string[]; readStatus?: number; newId?: number } = {}) {
  const stored: Record<string, unknown> = {};
  return async (url: string, init?: RequestInit) => {
    if (isWriteUrl(url)) {
      const body = JSON.parse(String(init!.body));
      const id = opts.newId ?? (body.method === 'POST' ? 321 : undefined);
      Object.assign(stored, body.payload);
      for (const f of opts.drop ?? []) delete stored[f];
      return new Response(JSON.stringify({ success: true, endpoint: body.endpoint, method: body.method, response: id ? { id } : { raw: '' } }), { status: 200 });
    }
    if (opts.readStatus) return new Response('boom', { status: opts.readStatus });
    return new Response(JSON.stringify(stored), { status: 200 });
  };
}

function writes(env: any) {
  return env.ST_TRANSPORT.fetch.mock.calls
    .filter(([url]: [string]) => isWriteUrl(url))
    .map(([, init]: [string, RequestInit]) => JSON.parse(String(init.body)));
}

function reads(env: any): string[] {
  return env.ST_TRANSPORT.fetch.mock.calls.map(([url]: [string]) => url).filter((u: string) => !isWriteUrl(u));
}

async function confirm(tool: any, env: any, args: any) {
  const dry: any = await tool.handler(env, args, CTX);
  const live: any = await tool.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX);
  return { dry, live };
}

describe('toStPricebookPayload', () => {
  it('renames name to displayName', () => {
    expect(toStPricebookPayload({ name: 'Drain', cost: 5 })).toEqual({ displayName: 'Drain', cost: 5 });
  });

  it('turns categoryId into categories[]', () => {
    expect(toStPricebookPayload({ categoryId: 9 })).toEqual({ categories: [9] });
  });

  it('prefers categories[] and drops categoryId when both are passed', () => {
    expect(toStPricebookPayload({ categoryId: 9, categories: [1, 2] })).toEqual({ categories: [1, 2] });
  });

  it('drops the singular useStaticPrice that ServiceTitan ignores, keeps useStaticPrices', () => {
    expect(toStPricebookPayload({ useStaticPrice: true, useStaticPrices: false })).toEqual({ useStaticPrices: false });
  });

  it('does not mutate its input', () => {
    const input = { name: 'A', categoryId: 3 };
    toStPricebookPayload(input);
    expect(input).toEqual({ name: 'A', categoryId: 3 });
  });
});

describe('st_patch_service', () => {
  const args = { id: 12345, name: 'Diag', cost: 75, categoryId: 4 };

  it('dry run returns a 5 minute token, shows the ST payload, and makes no ST call', async () => {
    const env = makeEnv(noCall);
    const dry: any = await st_patch_service.handler(env, args, CTX);
    expect(dry.dryRun).toBe(true);
    expect(dry.confirmation_token).toMatch(/^st_patch_service\|/);
    expect(dry.expires_in_seconds).toBe(300);
    expect(dry.st_method).toBe('PATCH');
    expect(dry.st_endpoint).toBe(`/pricebook/v2/tenant/${TENANT}/services/12345`);
    expect(dry.payload).toEqual({ displayName: 'Diag', cost: 75, categories: [4] });
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('confirm PATCHes the service endpoint with the rewritten payload', async () => {
    const env = makeEnv(sim());
    const { live } = await confirm(st_patch_service, env, args);
    expect(live.dryRun).toBe(false);
    expect(writes(env)).toHaveLength(1);
    const [body] = writes(env);
    expect(body).toEqual({
      endpoint: `/pricebook/v2/tenant/${TENANT}/services/12345`,
      method: 'PATCH',
      payload: { displayName: 'Diag', cost: 75, categories: [4] },
    });
  });

  it('rewrites the tenant placeholder to the configured tenant', async () => {
    const env = makeEnv(sim(), '555');
    await confirm(st_patch_service, env, args);
    expect(writes(env)[0].endpoint).toBe('/pricebook/v2/tenant/555/services/12345');
  });

  it('rejects a token minted for a different id before any ST call', async () => {
    const env = makeEnv(sim());
    const dry: any = await st_patch_service.handler(env, args, CTX);
    await expect(
      st_patch_service.handler(env, { ...args, id: 99999, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
    ).rejects.toThrow(/args changed/);
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('requires at least one field besides id', async () => {
    const env = makeEnv(noCall);
    await expect(st_patch_service.handler(env, { id: 12345 }, CTX)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('requires a token when dryRun=false', async () => {
    const env = makeEnv(noCall);
    await expect(st_patch_service.handler(env, { id: 1, cost: 5, dryRun: false }, CTX)).rejects.toMatchObject({ code: 'validation_error' });
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('surfaces a ServiceTitan failure as upstream_error', async () => {
    const env = makeEnv(async () => new Response('nope', { status: 500 }));
    const dry: any = await st_patch_service.handler(env, args, CTX);
    await expect(
      st_patch_service.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
    ).rejects.toMatchObject({ code: 'upstream_error' });
    expect(reads(env)).toHaveLength(0);
  });

  it('description carries the dynamic-pricing and flip warnings', () => {
    const d = st_patch_service.description;
    expect(d).toContain('Pricing mode follows useStaticPrices: when false, ServiceTitan computes price at invoice time (dynamic pricing), so do not set price/memberPrice unless useStaticPrices=true.');
    expect(d).not.toMatch(/Default is dynamic/);
    expect(d).toContain('useStaticPrices cannot be flipped from false→true via PATCH');
    expect(d).toMatch(/Use ST UI to flip/);
    expect(d).toContain('dryRun=true (default)');
  });
});

describe('st_create_service', () => {
  const args = { name: 'New Service', categoryId: 5, cost: 10 };

  it('dry run returns a token, shows the ST payload, and makes no ST call', async () => {
    const env = makeEnv(noCall);
    const dry: any = await st_create_service.handler(env, args, CTX);
    expect(dry.dryRun).toBe(true);
    expect(dry.confirmation_token).toMatch(/^st_create_service\|/);
    expect(dry.expires_in_seconds).toBe(300);
    expect(dry.st_method).toBe('POST');
    expect(dry.st_endpoint).toBe(`/pricebook/v2/tenant/${TENANT}/services`);
    expect(dry.payload).toEqual({ displayName: 'New Service', categories: [5], cost: 10 });
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('confirm POSTs to the services endpoint', async () => {
    const env = makeEnv(sim());
    await confirm(st_create_service, env, args);
    expect(writes(env)).toEqual([{
      endpoint: `/pricebook/v2/tenant/${TENANT}/services`,
      method: 'POST',
      payload: { displayName: 'New Service', categories: [5], cost: 10 },
    }]);
  });

  it('accepts categories[] in place of categoryId', async () => {
    const env = makeEnv(sim());
    await confirm(st_create_service, env, { name: 'Multi', categories: [1, 2] });
    expect(writes(env)[0].payload).toEqual({ displayName: 'Multi', categories: [1, 2] });
  });

  it('requires categoryId or categories[]', async () => {
    const env = makeEnv(noCall);
    await expect(st_create_service.handler(env, { name: 'No cat' }, CTX)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rejects a token minted for different args', async () => {
    const env = makeEnv(sim());
    const dry: any = await st_create_service.handler(env, args, CTX);
    await expect(
      st_create_service.handler(env, { ...args, cost: 11, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
    ).rejects.toThrow(/args changed/);
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('description carries the dynamic-pricing and create-time warnings', () => {
    const d = st_create_service.description;
    expect(d).toContain('Pricing mode follows useStaticPrices: when false, ServiceTitan computes price at invoice time (dynamic pricing), so do not set price/memberPrice unless useStaticPrices=true.');
    expect(d).not.toMatch(/Default is dynamic/);
    expect(d).toContain('Use useStaticPrices: true at create time');
    expect(d).toMatch(/cannot be flipped via PATCH post-create/);
  });
});

describe('st_patch_material', () => {
  const args = { id: 777, cost: 12.5, name: 'Elbow' };

  it('dry run returns a token and makes no ST call', async () => {
    const env = makeEnv(noCall);
    const dry: any = await st_patch_material.handler(env, args, CTX);
    expect(dry.dryRun).toBe(true);
    expect(dry.confirmation_token).toMatch(/^st_patch_material\|/);
    expect(dry.st_method).toBe('PATCH');
    expect(dry.st_endpoint).toBe(`/pricebook/v2/tenant/${TENANT}/materials/777`);
    expect(dry.payload).toEqual({ displayName: 'Elbow', cost: 12.5 });
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('confirm PATCHes the material endpoint', async () => {
    const env = makeEnv(sim());
    await confirm(st_patch_material, env, args);
    expect(writes(env)).toEqual([{
      endpoint: `/pricebook/v2/tenant/${TENANT}/materials/777`,
      method: 'PATCH',
      payload: { displayName: 'Elbow', cost: 12.5 },
    }]);
  });

  it('rejects a token minted for a different id before any ST call', async () => {
    const env = makeEnv(sim());
    const dry: any = await st_patch_material.handler(env, args, CTX);
    await expect(
      st_patch_material.handler(env, { ...args, id: 778, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
    ).rejects.toThrow(/args changed/);
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('requires at least one field besides id', async () => {
    const env = makeEnv(noCall);
    await expect(st_patch_material.handler(env, { id: 777 }, CTX)).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('st_create_material', () => {
  const args = { name: 'R-22', categoryId: 10, cost: 3, primaryVendorId: 555 };
  const expectedPayload = {
    displayName: 'R-22',
    categories: [10],
    cost: 3,
    primaryVendor: { vendorId: 555, cost: 3, active: true },
  };

  it('dry run resolves the flat vendor shorthand and makes no ST call', async () => {
    const env = makeEnv(noCall);
    const dry: any = await st_create_material.handler(env, args, CTX);
    expect(dry.dryRun).toBe(true);
    expect(dry.confirmation_token).toMatch(/^st_create_material\|/);
    expect(dry.st_method).toBe('POST');
    expect(dry.st_endpoint).toBe(`/pricebook/v2/tenant/${TENANT}/materials`);
    expect(dry.payload).toEqual(expectedPayload);
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('confirm POSTs to the materials endpoint', async () => {
    const env = makeEnv(sim());
    await confirm(st_create_material, env, args);
    expect(writes(env)).toEqual([{
      endpoint: `/pricebook/v2/tenant/${TENANT}/materials`,
      method: 'POST',
      payload: expectedPayload,
    }]);
  });

  it('accepts the nested primaryVendor object and keeps its own cost and active flag', async () => {
    const env = makeEnv(sim());
    await confirm(st_create_material, env, {
      name: 'Valve', categoryId: 2, cost: 8, primaryVendor: { vendorId: 7, cost: 6, active: false },
    });
    expect(writes(env)[0].payload.primaryVendor).toEqual({ vendorId: 7, cost: 6, active: false });
  });

  it('uses primaryVendorCost with the flat shorthand', async () => {
    const env = makeEnv(sim());
    await confirm(st_create_material, env, { name: 'Valve', categoryId: 2, cost: 8, primaryVendorId: 7, primaryVendorCost: 5 });
    expect(writes(env)[0].payload.primaryVendor).toEqual({ vendorId: 7, cost: 5, active: true });
  });

  it('rejects a create with no primary vendor', async () => {
    const env = makeEnv(noCall);
    await expect(st_create_material.handler(env, { name: 'X', categoryId: 1 }, CTX))
      .rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('primaryVendor is required') });
  });

  it('rejects a token minted for different args', async () => {
    const env = makeEnv(sim());
    const dry: any = await st_create_material.handler(env, args, CTX);
    await expect(
      st_create_material.handler(env, { ...args, primaryVendorId: 556, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
    ).rejects.toThrow(/args changed/);
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('description states the vendor requirement and the dynamic-pricing note', () => {
    const d = st_create_material.description;
    expect(d).toMatch(/exactly one primary vendor/);
    expect(d).toContain('A 0 or null price can mean the item is priced dynamically; set price only if you want a static price.');
    expect(d).not.toMatch(/does not mean/);
  });

  it('requires name and categoryId in the schema', () => {
    const schema = z.object(st_create_material.zodSchema);
    expect(schema.safeParse({ categoryId: 1 }).success).toBe(false);
    expect(schema.safeParse({ name: 'x' }).success).toBe(false);
    expect(schema.safeParse({ name: 'x', categoryId: 1 }).success).toBe(true);
  });
});

describe('registration and roles', () => {
  const names = ['st_patch_service', 'st_create_service', 'st_patch_material', 'st_create_material'];

  it('all four are registered as staff writes with an ST endpoint descriptor', () => {
    for (const n of names) {
      const t = PUBLIC_TOOLS.find((x) => x.name === n);
      expect(t, n).toBeDefined();
      expect(t!.isWrite).toBe(true);
      expect(t!.permission).toBe('staff');
      expect(t!.stEndpoint?.source).toBe('live');
    }
  });

  it('all four are hidden for readonly and lockdown', () => {
    for (const role of ['readonly', 'lockdown'] as const) {
      const visible = filterToolsForRole(PUBLIC_TOOLS, role).map((t) => t.name);
      for (const n of names) expect(visible, `${role}:${n}`).not.toContain(n);
    }
  });
});

describe('read-back verification', () => {
  const patchArgs = { id: 12345, name: 'Diag', cost: 75, categoryId: 4 };

  it('PATCH with a matching read-back is verified and reads the same resource', async () => {
    const env = makeEnv(sim());
    const { live } = await confirm(st_patch_service, env, patchArgs);
    expect(live.verified).toBe(true);
    expect(live.outcome).toEqual({ remotely_verified: true });
    expect(reads(env)).toHaveLength(1);
    const readUrl = new URL(reads(env)[0]);
    expect(readUrl.searchParams.get('endpoint')).toBe(`/pricebook/v2/tenant/${TENANT}/services/12345`);
  });

  it('PATCH where ServiceTitan drops a field reports that field as a mismatch', async () => {
    const env = makeEnv(sim({ drop: ['displayName'] }));
    const { live } = await confirm(st_patch_service, env, patchArgs);
    expect(live.dryRun).toBe(false);
    expect(live.verified).toBe(false);
    expect(live.outcome.remotely_verified).toBe(false);
    expect(live.outcome.mismatched_fields).toEqual(['displayName']);
  });

  it('a stored value that differs (not just missing) is a mismatch; numeric strings compare equal', async () => {
    const stored: Record<string, unknown> = { cost: '75.0000', displayName: 'Other', categories: [4] };
    const env = makeEnv(async (url: string) =>
      isWriteUrl(url) ? new Response(JSON.stringify({ success: true, response: { raw: '' } }), { status: 200 }) : new Response(JSON.stringify(stored), { status: 200 }));
    const { live } = await confirm(st_patch_service, env, patchArgs);
    expect(live.outcome.mismatched_fields).toEqual(['displayName']);
  });

  it('a failed read-back is still reported as written, unverified, and does not throw', async () => {
    const env = makeEnv(sim({ readStatus: 500 }));
    const { live } = await confirm(st_patch_service, env, patchArgs);
    expect(live.dryRun).toBe(false);
    expect(live.result).toBeDefined();
    expect(live.verified).toBe(false);
    expect(live.outcome.remotely_verified).toBe(false);
    expect(live.outcome.note).toMatch(/read-back failed/);
    expect(writes(env)).toHaveLength(1);
  });

  it('POST reads back the id returned by the write', async () => {
    const env = makeEnv(sim({ newId: 987 }));
    const { live } = await confirm(st_create_service, env, { name: 'New', categoryId: 5, cost: 10 });
    expect(live.verified).toBe(true);
    expect(new URL(reads(env)[0]).searchParams.get('endpoint')).toBe(`/pricebook/v2/tenant/${TENANT}/services/987`);
  });

  it('POST whose response has no id is unverified with a note, without a read', async () => {
    const env = makeEnv(async (url: string) =>
      isWriteUrl(url) ? new Response(JSON.stringify({ success: true, response: { raw: '' } }), { status: 200 }) : new Response('{}', { status: 200 }));
    const { live } = await confirm(st_create_service, env, { name: 'New', categoryId: 5 });
    expect(live.verified).toBe(false);
    expect(live.outcome.note).toMatch(/no id/);
    expect(reads(env)).toHaveLength(0);
  });

  it('material create compares the nested primary vendor and reads the materials resource', async () => {
    const env = makeEnv(sim({ newId: 55 }));
    const ok = await confirm(st_create_material, env, { name: 'R-22', categoryId: 10, cost: 3, primaryVendorId: 555 });
    expect(ok.live.verified).toBe(true);
    expect(new URL(reads(env)[0]).searchParams.get('endpoint')).toBe(`/pricebook/v2/tenant/${TENANT}/materials/55`);

    const bad = makeEnv(sim({ newId: 55, drop: ['primaryVendor'] }));
    const dropped = await confirm(st_create_material, bad, { name: 'R-22', categoryId: 10, cost: 3, primaryVendorId: 555 });
    expect(dropped.live.outcome.mismatched_fields).toEqual(['primaryVendor.vendorId', 'primaryVendor.cost', 'primaryVendor.active']);
  });

  it('material patch verifies against the materials resource', async () => {
    const env = makeEnv(sim());
    const { live } = await confirm(st_patch_material, env, { id: 777, cost: 12.5 });
    expect(live.verified).toBe(true);
    expect(new URL(reads(env)[0]).searchParams.get('endpoint')).toBe(`/pricebook/v2/tenant/${TENANT}/materials/777`);
  });
});

// Goes through registerTool and recoverableWrite, the path real requests take.
describe('through the registry', () => {
  function opsDB() {
    const ops = new Map<string, any>();
    const owners = new Map<string, string>();
    const base = makeStatefulDB();
    return {
      ops,
      prepare: vi.fn((sql: string) => {
        if (!/mcp_operations|mcp_confirmation_owners/i.test(sql)) return base.prepare(sql);
        const captured: unknown[] = [];
        const stmt: any = {
          bind: (...a: unknown[]) => { captured.push(...a); return stmt; },
          run: async () => {
            if (/^INSERT OR IGNORE INTO mcp_confirmation_owners/i.test(sql)) {
              owners.set(String(captured[0]), String(captured[1]));
              return { success: true, meta: { changes: 1 } };
            }
            if (/^INSERT OR IGNORE INTO mcp_operations/i.test(sql)) {
              const [id, owner, role, tool, args_hash, state] = captured as string[];
              if (ops.has(id)) return { success: true, meta: { changes: 0 } };
              ops.set(id, { id, owner, role, tool, args_hash, state, instance_id: null, result: null, updated_at: Date.now() });
              return { success: true, meta: { changes: 1 } };
            }
            if (/^UPDATE mcp_operations SET state = \?, result = \?/i.test(sql)) {
              const [state, result, , id] = captured as any[];
              Object.assign(ops.get(id), { state, result });
            } else if (/^UPDATE mcp_operations SET state = \?/i.test(sql)) {
              const [state, , id] = captured as any[];
              Object.assign(ops.get(id), { state });
            }
            return { success: true, meta: { changes: 1 } };
          },
          first: async () => /mcp_confirmation_owners/i.test(sql)
            ? (owners.has(String(captured[0])) ? { owner: owners.get(String(captured[0])) } : null)
            : ops.get(String(captured[0])) ?? null,
        };
        return stmt;
      }),
    };
  }

  it('dry run, confirm, then replay of the same token makes exactly one ST write and returns an operation_id', async () => {
    const stored: Record<string, unknown> = {};
    let writeCount = 0;
    const env: any = makeEnv(async () => new Response('{}'));
    env.DB = opsDB();
    env.MCP_METRICS = { writeDataPoint: vi.fn() };
    env.ST_RATE_LIMITER = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }),
    };
    // The registry hands the transport a Request, so read the body from it.
    env.ST_TRANSPORT = {
      fetch: vi.fn(async (input: Request) => {
        const url = new URL(input.url);
        if (url.pathname === '/api/st/write') {
          writeCount++;
          const body = JSON.parse(await input.text());
          Object.assign(stored, body.payload);
          return new Response(JSON.stringify({ success: true, response: { raw: '' } }), { status: 200 });
        }
        return new Response(JSON.stringify(stored), { status: 200 });
      }),
    };

    const registrations: Array<{ name: string; handler: (args: any, extra?: any) => Promise<any> }> = [];
    const server: any = { registerTool: (name: string, _c: unknown, handler: any) => registrations.push({ name, handler }) };
    const execCtx: any = { waitUntil: () => undefined };
    registerTool(server, st_patch_service as any, env, execCtx, { actor: 'reg-test', role: 'default', principal: 'p1' } as any);
    const call = registrations.find((r) => r.name === 'st_patch_service')!.handler;

    const args = { id: 12345, cost: 75 };
    const dry = (await call({ ...args, dryRun: true })).structuredContent;
    expect(dry.dryRun).toBe(true);
    const confirmArgs = { ...args, dryRun: false, confirmation_token: dry.confirmation_token };

    const first = (await call(confirmArgs)).structuredContent;
    expect(first.operation_id).toEqual(expect.any(String));
    expect(first.state).toBe('verified');
    expect(first.verified).toBe(true);
    expect(writeCount).toBe(1);

    const replay = (await call(confirmArgs)).structuredContent;
    expect(replay.operation_id).toBe(first.operation_id);
    expect(writeCount).toBe(1);
  });
});
