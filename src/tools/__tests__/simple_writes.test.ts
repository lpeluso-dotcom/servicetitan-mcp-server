import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { sell_estimate, unsell_estimate, dismiss_estimate } from '../estimates/update_estimate_status';
import { create_recurring_service } from '../memberships/create_recurring_service';
import { assign_technicians } from '../jobs/assign_technicians';
import { PUBLIC_TOOLS, CUT_FROM_RELEASE_1 } from '../public-registry';
import { filterToolsForRole } from '../role-filter';

const CTX = { actor: 'vitest', correlation: 'test-corr' };

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

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_TRANSPORT: { fetch: vi.fn(fetchImpl) },
    ST_TENANT_ID: '555',
    CONFIRMATION_SIGNING_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeStatefulDB(),
    STATE_KV: {},
  };
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function writes(env: any) {
  return env.ST_TRANSPORT.fetch.mock.calls.map(([, init]: [string, RequestInit]) => JSON.parse(String(init.body)));
}

describe('estimate status writes', () => {
  const cases: Array<[string, any, any, string, unknown]> = [
    ['sell_estimate', sell_estimate, { estimateId: 11, soldBy: 7 }, 'sell', { soldBy: 7 }],
    ['unsell_estimate', unsell_estimate, { estimateId: 11 }, 'unsell', {}],
    ['dismiss_estimate', dismiss_estimate, { estimateId: 11 }, 'dismiss', {}],
  ];

  for (const [name, tool, args, action, payload] of cases) {
    it(`${name}: dry run returns a token and makes no ST call`, async () => {
      const env = makeEnv(async () => { throw new Error('no ST call on dry run'); });
      const dry: any = await tool.handler(env, args, CTX);
      expect(dry.dryRun).toBe(true);
      expect(dry.confirmation_token).toMatch(new RegExp(`^${name}\\|`));
      expect(dry.st_method).toBe('PUT');
      expect(dry.st_endpoint).toBe(`/sales/v2/tenant/555/estimates/11/${action}`);
      expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
    });

    it(`${name}: confirm with a valid token PUTs to the action endpoint`, async () => {
      const env = makeEnv(async () => ok());
      const dry: any = await tool.handler(env, args, CTX);
      const live: any = await tool.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX);
      expect(live.dryRun).toBe(false);
      expect(env.ST_TRANSPORT.fetch).toHaveBeenCalledTimes(1);
      const [body] = writes(env);
      expect(body.endpoint).toBe(`/sales/v2/tenant/555/estimates/11/${action}`);
      expect(body.method).toBe('PUT');
      expect(body.payload).toEqual(payload);
    });
  }

  it('sell_estimate rejects a token minted for a different estimateId', async () => {
    const env = makeEnv(async () => ok());
    const dry: any = await sell_estimate.handler(env, { estimateId: 11, soldBy: 7 }, CTX);
    await expect(
      sell_estimate.handler(env, { estimateId: 12, soldBy: 7, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
    ).rejects.toThrow(/args changed/);
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('sell_estimate requires soldBy', () => {
    expect(z.object(sell_estimate.zodSchema).safeParse({ estimateId: 1 }).success).toBe(false);
  });
});

describe('create_recurring_service', () => {
  const args = { membershipId: 5, serviceTypeId: 9, locationId: 3 };

  it('dry run returns a token and makes no ST call', async () => {
    const env = makeEnv(async () => { throw new Error('no ST call on dry run'); });
    const dry: any = await create_recurring_service.handler(env, args, CTX);
    expect(dry.dryRun).toBe(true);
    expect(dry.confirmation_token).toMatch(/^create_recurring_service\|/);
    expect(dry.st_endpoint).toBe('/memberships/v2/tenant/555/recurring-service-types/9/recurring-services');
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('confirm POSTs to the recurring-services endpoint', async () => {
    const env = makeEnv(async () => ok());
    const dry: any = await create_recurring_service.handler(env, args, CTX);
    await create_recurring_service.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX);
    const [body] = writes(env);
    expect(body.endpoint).toBe('/memberships/v2/tenant/555/recurring-service-types/9/recurring-services');
    expect(body.method).toBe('POST');
    expect(body.payload).toEqual(args);
  });
});

describe('assign_technicians', () => {
  const args = { appointmentId: 21, technicianIds: [4, 6] };

  it('dry run shows both steps, returns a token, makes no ST call', async () => {
    const env = makeEnv(async () => { throw new Error('no ST call on dry run'); });
    const dry: any = await assign_technicians.handler(env, args, CTX);
    expect(dry.dryRun).toBe(true);
    expect(dry.confirmation_token).toMatch(/^assign_technicians\|/);
    expect(dry.payload.steps).toHaveLength(2);
    expect(dry.payload.steps[0].endpoint).toBe('/dispatch/v2/tenant/555/appointment-assignments/unassign-technicians');
    expect(dry.payload.steps[1].endpoint).toBe('/dispatch/v2/tenant/555/appointment-assignments/assign-technicians');
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('confirm POSTs unassign then assign', async () => {
    const env = makeEnv(async () => ok());
    const dry: any = await assign_technicians.handler(env, args, CTX);
    const live: any = await assign_technicians.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX);
    expect(live.dryRun).toBe(false);
    const calls = writes(env);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ endpoint: '/dispatch/v2/tenant/555/appointment-assignments/unassign-technicians', method: 'POST', payload: { appointmentId: 21 } });
    expect(calls[1]).toEqual({ endpoint: '/dispatch/v2/tenant/555/appointment-assignments/assign-technicians', method: 'POST', payload: { appointmentId: 21, technicianIds: [4, 6] } });
  });

  it('rejects a token minted for different technicianIds before any ST call', async () => {
    const env = makeEnv(async () => ok());
    const dry: any = await assign_technicians.handler(env, args, CTX);
    await expect(
      assign_technicians.handler(env, { appointmentId: 21, technicianIds: [4], dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
    ).rejects.toThrow(/args changed/);
    expect(env.ST_TRANSPORT.fetch).not.toHaveBeenCalled();
  });

  it('does not assign when the unassign step fails', async () => {
    const env = makeEnv(async () => new Response('boom', { status: 500 }));
    const dry: any = await assign_technicians.handler(env, args, CTX);
    await expect(
      assign_technicians.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX)
    ).rejects.toMatchObject({ code: 'upstream_error' });
    expect(env.ST_TRANSPORT.fetch).toHaveBeenCalledTimes(1);
  });

  it('requires at least one technician', () => {
    expect(z.object(assign_technicians.zodSchema).safeParse({ appointmentId: 1, technicianIds: [] }).success).toBe(false);
  });
});

describe('registration and roles', () => {
  const names = ['sell_estimate', 'unsell_estimate', 'dismiss_estimate', 'create_recurring_service'];

  it('assign_technicians is held back from the registry, with its reason in CUT_FROM_RELEASE_1', () => {
    expect(PUBLIC_TOOLS.some((t) => t.name === 'assign_technicians')).toBe(false);
    expect(CUT_FROM_RELEASE_1.assign_technicians).toBe(
      "Held back: ServiceTitan's appointment-assignment request contract (path and body field names) is not yet verified against a live tenant, and the two-step unassign/assign is not atomic.",
    );
  });

  it('all four are registered as staff writes', () => {
    for (const n of names) {
      const t = PUBLIC_TOOLS.find((x) => x.name === n);
      expect(t, n).toBeDefined();
      expect(t!.isWrite).toBe(true);
      expect(t!.permission).toBe('staff');
    }
  });

  it('all four are hidden for readonly and lockdown', () => {
    for (const role of ['readonly', 'lockdown'] as const) {
      const visible = filterToolsForRole(PUBLIC_TOOLS, role).map((t) => t.name);
      for (const n of names) expect(visible, `${role}:${n}`).not.toContain(n);
    }
  });
});
