import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { st_create_adjustment_invoice } from '../st_create_adjustment_invoice';
import { McpError } from '../../../errors';
import { PUBLIC_TOOLS, CUT_FROM_RELEASE_1 } from '../../public-registry';
import { filterToolsForRole } from '../../role-filter';
import { registerTool } from '../../../tool-registry';
import { makeStatefulDB } from '../../sales/__tests__/helpers';

const CTX = { actor: 'vitest', correlation: 'test-corr' };
const PARENT = 1001;
const CREATED = 2002;

// ── ServiceTitan simulator ───────────────────────────────────
// Serves the parent invoice, the pricebook catalogues (for the SKU pre-check),
// and the adjustment create. The created invoice is readable after the POST and
// reflects what the POST carried, because the tool verifies by re-reading. The
// read side serializes numbers as strings, the way the live API does.
interface SimOpts {
  tenant?: string;
  parent?: Record<string, unknown>;
  services?: Array<Record<string, unknown>>;
  materials?: Array<Record<string, unknown>>;
  equipment?: Array<Record<string, unknown>>;
  /** Fail reads of these catalogue segments with HTTP 500. */
  failCatalogs?: Array<'services' | 'materials' | 'equipment'>;
  /** Override the parent/created invoice read. */
  onInvoiceRead?: (state: { ids: number; postCount: number; readCount: number }) => Response | undefined;
  /** Override the create response. */
  onPost?: (payload: any) => Response | undefined;
  /** Model ST dropping lines (returns the items that actually land). */
  landed?: (items: any[]) => any[] | null;
  /** Model ST persisting a different price than was sent. */
  persistedPrice?: (item: any) => number;
}

function makeSim(opts: SimOpts = {}) {
  const tenant = opts.tenant ?? '000000000';
  const parent = { id: PARENT, syncStatus: 'Posted', adjustmentToId: null, items: [], ...(opts.parent ?? {}) };
  const catalogs: Record<string, Array<Record<string, unknown>>> = {
    services: opts.services ?? [{ id: 1, code: 'SKU1', displayName: 'First service' }],
    materials: opts.materials ?? [{ id: 2, code: 'SKU2', displayName: 'First material' }],
    equipment: opts.equipment ?? [],
  };
  const posts: any[] = [];
  const reads: string[] = [];
  let created: Record<string, unknown> | undefined;
  let readCount = 0;

  const env: any = {
    ST_TRANSPORT: {
      fetch: vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname === '/api/st/write') {
          const raw = typeof input === 'string' ? String(init!.body) : await input.text();
          const body = JSON.parse(raw);
          posts.push(body);
          const override = opts.onPost?.(body.payload);
          if (override) return override;
          const sent: any[] = body.payload.items ?? [];
          const landedItems = opts.landed ? opts.landed(sent) : sent;
          created = {
            id: CREATED,
            syncStatus: 'Pending',
            adjustmentToId: body.payload.adjustmentToId,
            items: landedItems === null ? null : landedItems.map((it, i) => ({
              id: 7000 + i,
              skuName: it.skuName,
              description: it.description,
              quantity: Number(it.quantity).toFixed(19),
              cost: it.cost !== undefined ? Number(it.cost).toFixed(10) : '0.0000000000',
              price: (opts.persistedPrice ? opts.persistedPrice(it) : (it.unitPrice ?? 0)).toFixed(2),
            })),
            subTotal: '0',
            total: '0',
          };
          return new Response(JSON.stringify({ success: true, endpoint: body.endpoint, method: body.method, response: CREATED }), { status: 200 });
        }
        const endpoint = url.searchParams.get('endpoint') ?? '/';
        reads.push(endpoint);
        const parsed = new URL(endpoint, 'https://x.invalid');
        const seg = parsed.pathname.split('/').pop() as string;
        if (parsed.pathname.includes('/pricebook/')) {
          if (opts.failCatalogs?.includes(seg as any)) return new Response('upstream broke', { status: 500 });
          return new Response(JSON.stringify({ data: catalogs[seg] ?? [], hasMore: false, page: 1 }), { status: 200 });
        }
        readCount++;
        const ids = Number(parsed.searchParams.get('ids'));
        const override = opts.onInvoiceRead?.({ ids, postCount: posts.length, readCount });
        if (override) return override;
        const row = ids === CREATED ? created : ids === PARENT ? parent : undefined;
        return new Response(JSON.stringify({ data: row ? [row] : [] }), { status: 200 });
      }),
    },
    ST_TENANT_ID: tenant,
    CONFIRMATION_SIGNING_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeStatefulDB(),
    STATE_KV: {},
    VERIFY_BACKOFF_MS: [0, 0],
  };
  return {
    env, posts, reads, catalogs, opts,
    get tokens() { return (env.DB as ReturnType<typeof makeStatefulDB>).tokens; },
    get created() { return created; },
  };
}

const tool = st_create_adjustment_invoice;
const LINE = { skuName: 'SKU1', description: 'Offsetting credit', quantity: 1, unitPrice: -1234.56 };
const ARGS = { parentInvoiceId: PARENT, lineItems: [LINE] };

async function dry(sim: ReturnType<typeof makeSim>, args: any = ARGS): Promise<any> {
  return tool.handler(sim.env, args, CTX);
}
async function confirm(sim: ReturnType<typeof makeSim>, args: any = ARGS): Promise<any> {
  const d = await dry(sim, args);
  return tool.handler(sim.env, { ...args, dryRun: false, confirmation_token: d.confirmation_token }, CTX);
}

describe('input schema', () => {
  const schema = z.object(tool.zodSchema);
  const base = { parentInvoiceId: 1, lineItems: [{ skuName: 'A', quantity: 1, unitPrice: -5 }] };

  it('accepts a well-formed call', () => {
    expect(schema.safeParse(base).success).toBe(true);
  });

  it('rejects `price` and `skuId` on a line with a message naming the replacement', () => {
    const withPrice = schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], price: 5 }] });
    expect(withPrice.success).toBe(false);
    expect(JSON.stringify((withPrice as any).error.issues)).toContain('unitPrice');
    const withSkuId = schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], skuId: 5 }] });
    expect(withSkuId.success).toBe(false);
    expect(JSON.stringify((withSkuId as any).error.issues)).toContain('skuName');
  });

  it('rejects unknown line fields and an empty skuName', () => {
    expect(schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], taxable: true }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], skuName: '' }] }).success).toBe(false);
  });

  it('rejects a whitespace-only skuName at the schema and trims surrounding whitespace', () => {
    expect(schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], skuName: '   ' }] }).success).toBe(false);
    const ok: any = schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], skuName: '  SKU1 ' }] });
    expect(ok.success).toBe(true);
    expect(ok.data.lineItems[0].skuName).toBe('SKU1');
  });

  it('rejects top-level businessUnitId and invoiceDate, which ServiceTitan ignores on this call', () => {
    expect(schema.safeParse({ ...base, businessUnitId: 3 }).success).toBe(false);
    expect(schema.safeParse({ ...base, invoiceDate: '2026-01-01' }).success).toBe(false);
  });
});

describe('validation', () => {
  it('rejects an empty lineItems list before any read', async () => {
    const sim = makeSim();
    await expect(dry(sim, { parentInvoiceId: PARENT, lineItems: [] })).rejects.toMatchObject({ code: 'validation_error' });
    expect(sim.reads).toHaveLength(0);
  });

  it('rejects a line with no skuName', async () => {
    const sim = makeSim();
    await expect(dry(sim, { parentInvoiceId: PARENT, lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }] }))
      .rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('skuName') });
  });
});

describe('resolved SKU on the wire', () => {
  const AB = { id: 5, code: 'AB-12', displayName: 'Widget', active: true };
  const ABLINE = { skuName: 'ab12', description: 'Credit', quantity: 1, unitPrice: -10 };
  const ABARGS = { parentInvoiceId: PARENT, lineItems: [ABLINE] };

  it('the preview shows the resolved code, not the caller\'s string', async () => {
    const sim = makeSim({ services: [AB] });
    const out = await dry(sim, ABARGS);
    expect(out.payload.items[0].skuName).toBe('AB-12');
    expect(out.skuResolution.resolved[0]).toMatchObject({ skuName: 'ab12', matched: 'AB-12', kind: 'service' });
  });

  it('puts the matched row\'s exact code on the wire for input "ab12" against code "AB-12"', async () => {
    const sim = makeSim({ services: [AB] });
    const result = await confirm(sim, ABARGS);
    expect(sim.posts[0].payload.items[0].skuName).toBe('AB-12');
    expect(result.verified).toBe(true);
  });

  it('a pricebook code that changes between preview and confirm invalidates the token', async () => {
    const sim = makeSim({ services: [AB] });
    const d = await dry(sim, ABARGS);
    sim.catalogs.services[0] = { ...AB, code: 'AB12' }; // "ab12" now resolves to a different code
    await expect(tool.handler(sim.env, { ...ABARGS, dryRun: false, confirmation_token: d.confirmation_token }, CTX))
      .rejects.toThrow(/args changed since dryRun/);
    expect(sim.posts).toHaveLength(0);
  });

  it('a display name is not a SKU: a name-only input is refused with no token and no POST', async () => {
    const sim = makeSim({ services: [{ id: 1, code: 'SKU1', displayName: 'First service' }] });
    const err: any = await dry(sim, { parentInvoiceId: PARENT, lineItems: [{ ...LINE, skuName: 'First service' }] }).catch((e) => e);
    expect(err.code).toBe('validation_error');
    expect(err.message).toContain('First service');
    expect(sim.tokens.size).toBe(0);
    expect(sim.posts).toHaveLength(0);
  });

  it('an ambiguous SKU is a validation error listing the candidates: no token, no POST', async () => {
    const sim = makeSim({ services: [{ id: 1, code: 'SKU1' }], materials: [{ id: 2, code: 'SKU1' }] });
    const err: any = await dry(sim).catch((e) => e);
    expect(err.code).toBe('validation_error');
    expect(err.message).toContain('lineItems[0]');
    expect(err.message).toContain('service SKU1 (id 1)');
    expect(err.message).toContain('material SKU1 (id 2)');
    expect(err.message).toMatch(/more than one/i);
    expect(sim.tokens.size).toBe(0);
    expect(sim.posts).toHaveLength(0);
  });

  it('an ambiguous SKU at confirm never reaches the POST', async () => {
    const sim = makeSim();
    const d = await dry(sim);
    sim.catalogs.materials.push({ id: 8, code: 'SKU1' });
    await expect(tool.handler(sim.env, { ...ARGS, dryRun: false, confirmation_token: d.confirmation_token }, CTX))
      .rejects.toMatchObject({ code: 'validation_error', message: expect.stringMatching(/more than one/i) });
    expect(sim.posts).toHaveLength(0);
  });

  it('warns, without blocking, when the SKU is inactive in the pricebook', async () => {
    const sim = makeSim({ services: [{ id: 1, code: 'SKU1', active: false }] });
    const out = await dry(sim);
    expect(out.warnings).toContain('SKU SKU1 is inactive in the pricebook; ServiceTitan may drop it from a new invoice');
    expect(out.confirmation_token).toBeDefined();
    const result = await confirm(sim);
    expect(result.verified).toBe(true);
    expect(sim.posts).toHaveLength(1);
  });

  it('does not warn for an active SKU or one with no active flag', async () => {
    const sim = makeSim({ services: [{ id: 1, code: 'SKU1', active: true }] });
    expect((await dry(sim)).warnings).toEqual([]);
  });

  it('rejects a whitespace-only skuName at the handler too', async () => {
    const sim = makeSim();
    await expect(dry(sim, { parentInvoiceId: PARENT, lineItems: [{ ...LINE, skuName: '   ' }] }))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect(sim.posts).toHaveLength(0);
  });
});

describe('dry run', () => {
  it('issues a token and previews the exact POST body, with no write', async () => {
    const sim = makeSim();
    const out = await dry(sim, { ...ARGS, summary: 'Credit memo' });
    expect(out.dryRun).toBe(true);
    expect(out.tool).toBe('st_create_adjustment_invoice');
    expect(out.confirmation_token).toMatch(/^st_create_adjustment_invoice\|/);
    expect(out.payload).toEqual({
      adjustmentToId: PARENT,
      summary: 'Credit memo',
      items: [{ skuName: 'SKU1', description: 'Offsetting credit', quantity: 1, unitPrice: -1234.56 }],
    });
    expect(out.payload).not.toHaveProperty('lineItems');
    expect(out.warnings).toEqual([]);
    expect(sim.posts).toHaveLength(0);
    expect(sim.tokens.size).toBe(1);
  });

  it('reports how each SKU resolved', async () => {
    const sim = makeSim();
    const out = await dry(sim, { parentInvoiceId: PARENT, lineItems: [LINE, { skuName: 'SKU2', quantity: 2, unitPrice: -5 }] });
    expect(out.skuResolution.resolved).toEqual([
      { status: 'resolved', skuName: 'SKU1', matched: 'SKU1', kind: 'service' },
      { status: 'resolved', skuName: 'SKU2', matched: 'SKU2', kind: 'material' },
    ]);
  });

  it('refuses an unresolvable SKU: validation error, no token, no POST', async () => {
    const sim = makeSim();
    const err: any = await dry(sim, { parentInvoiceId: PARENT, lineItems: [LINE, { skuName: 'NOPE9', quantity: 1, unitPrice: -5 }] }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('validation_error');
    expect(err.message).toContain('lineItems[1]');
    expect(err.message).toContain('NOPE9');
    expect(err.message).toMatch(/not.*deletable|cannot be deleted/i);
    expect(sim.tokens.size).toBe(0);
    expect(sim.posts).toHaveLength(0);
  });

  it('fails closed when the live SKU lookup is unavailable: validation error, says it could not be verified, no token, no POST', async () => {
    const sim = makeSim({ services: [], materials: [], failCatalogs: ['equipment'] });
    const err: any = await dry(sim).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('validation_error');
    expect(err.message).toMatch(/could not be verified/i);
    expect(err.message).toContain('SKU1');
    expect(sim.tokens.size).toBe(0);
    expect(sim.posts).toHaveLength(0);
  });

  it('warns, without blocking, when a line has no unitPrice', async () => {
    const sim = makeSim();
    const out = await dry(sim, { parentInvoiceId: PARENT, lineItems: [{ skuName: 'SKU1', quantity: 1 }] });
    expect(out.dryRun).toBe(true);
    expect(out.warnings.some((w: string) => /unitPrice/.test(w) && /SKU1/.test(w) && /\$0\.00/.test(w))).toBe(true);
  });

  it('warns when offsetAmount does not net the line total to zero', async () => {
    const sim = makeSim();
    const out = await dry(sim, { ...ARGS, offsetAmount: 1000 });
    expect(out.warnings.some((w: string) => /offsetAmount/.test(w))).toBe(true);
    const ok = await dry(sim, { ...ARGS, offsetAmount: 1234.56 });
    expect(ok.warnings).toEqual([]);
  });

  it('returns a clean not_found tool error when the parent invoice is missing', async () => {
    const sim = makeSim({ onInvoiceRead: () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
    await expect(dry(sim)).rejects.toMatchObject({ code: 'not_found' });
    expect(sim.tokens.size).toBe(0);
  });

  it('returns a clean not_found tool error when ServiceTitan answers 404 on the parent read', async () => {
    const sim = makeSim({ onInvoiceRead: () => new Response('missing', { status: 404 }) });
    const err: any = await dry(sim).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('not_found');
    expect(sim.posts).toHaveLength(0);
  });

  it('fails when the ids filter is not honored on the parent read', async () => {
    const sim = makeSim({ parent: { id: 9999 } });
    await expect(dry(sim)).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('ids filter not honored') });
  });

  it('refuses a parent that is not Posted or Exported', async () => {
    const sim = makeSim({ parent: { syncStatus: 'Pending' } });
    await expect(dry(sim)).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('Posted or Exported') });
    expect(sim.tokens.size).toBe(0);
  });

  it('allows an Exported parent', async () => {
    const sim = makeSim({ parent: { syncStatus: 'Exported' } });
    expect((await dry(sim)).dryRun).toBe(true);
  });

  it('refuses a parent that is itself an adjustment invoice', async () => {
    const sim = makeSim({ parent: { adjustmentToId: 555 } });
    await expect(dry(sim)).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('adjustment-of-adjustment') });
  });
});

describe('confirm', () => {
  it('POSTs the invoices endpoint once with an `items` body built from the allow-list', async () => {
    const sim = makeSim();
    const result = await confirm(sim, { ...ARGS, summary: 'Credit memo' });
    expect(result.dryRun).toBe(false);
    expect(sim.posts).toHaveLength(1);
    expect(sim.posts[0].method).toBe('POST');
    expect(sim.posts[0].endpoint).toBe('/accounting/v2/tenant/000000000/invoices');
    expect(sim.posts[0].payload).toEqual({
      adjustmentToId: PARENT,
      summary: 'Credit memo',
      items: [{ skuName: 'SKU1', description: 'Offsetting credit', quantity: 1, unitPrice: -1234.56 }],
    });
    expect(sim.posts[0].payload).not.toHaveProperty('lineItems');
  });

  it('writes to the configured tenant, not the placeholder', async () => {
    const sim = makeSim({ tenant: '123456789' });
    const result = await confirm(sim);
    expect(result.verified).toBe(true);
    expect(sim.posts[0].endpoint).toBe('/accounting/v2/tenant/123456789/invoices');
    expect(sim.posts[0].endpoint).not.toContain('000000000');
    // The preview shows the same tenant-resolved endpoint the write used.
    const preview = await dry(makeSim({ tenant: '123456789' }));
    expect(preview.st_endpoint).toBe('/accounting/v2/tenant/123456789/invoices');
    expect(preview.st_method).toBe('POST');
  });

  it('keeps unitPrice (negative, exact) on the wire and never sends price or skuId', async () => {
    const sim = makeSim();
    const args: any = { parentInvoiceId: PARENT, lineItems: [{ ...LINE }] };
    const result = await confirm(sim, args);
    const sent = sim.posts[0].payload.items[0];
    expect(sent.unitPrice).toBe(-1234.56);
    expect(sent).not.toHaveProperty('price');
    expect(sent).not.toHaveProperty('skuId');
    expect(result.verification.actualTotal).toBeCloseTo(-1234.56, 2);
  });

  it('resolves the SKUs again at confirm: a SKU that vanished between preview and confirm never reaches the POST', async () => {
    const sim = makeSim();
    const d = await dry(sim);
    sim.catalogs.services.length = 0; // SKU1 removed from the pricebook after the preview
    await expect(tool.handler(sim.env, { ...ARGS, dryRun: false, confirmation_token: d.confirmation_token }, CTX))
      .rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('SKU1') });
    expect(sim.posts).toHaveLength(0);
  });

  it('fails closed at confirm when the live SKU lookup goes down after the preview', async () => {
    const sim = makeSim();
    const d = await dry(sim);
    sim.opts.failCatalogs = ['services', 'materials', 'equipment'];
    const err: any = await tool.handler(sim.env, { ...ARGS, dryRun: false, confirmation_token: d.confirmation_token }, CTX).catch((e) => e);
    expect(err.code).toBe('validation_error');
    expect(err.message).toMatch(/could not be verified/i);
    expect(sim.posts).toHaveLength(0);
  });

  it('rejects a token minted for different line items before any POST', async () => {
    const sim = makeSim();
    const d = await dry(sim);
    await expect(
      tool.handler(sim.env, { ...ARGS, lineItems: [{ ...LINE, unitPrice: -9999 }], dryRun: false, confirmation_token: d.confirmation_token }, CTX),
    ).rejects.toThrow(/args changed/);
    expect(sim.posts).toHaveLength(0);
  });

  it('rejects a token minted for a different parent invoice before any POST', async () => {
    const sim = makeSim({
      onInvoiceRead: ({ ids }) => new Response(JSON.stringify({ data: [{ id: ids, syncStatus: 'Posted', adjustmentToId: null }] }), { status: 200 }),
    });
    const d = await dry(sim);
    await expect(
      tool.handler(sim.env, { ...ARGS, parentInvoiceId: PARENT + 1, dryRun: false, confirmation_token: d.confirmation_token }, CTX),
    ).rejects.toThrow(/args changed/);
    expect(sim.posts).toHaveLength(0);
  });

  it('requires a confirmation_token when dryRun is false', async () => {
    const sim = makeSim();
    await expect(tool.handler(sim.env, { ...ARGS, dryRun: false }, CTX)).rejects.toMatchObject({ code: 'validation_error' });
    expect(sim.posts).toHaveLength(0);
  });

  it('rejects the confirm when the parent status changed between preview and confirm', async () => {
    const statuses = ['Posted', 'Exported'];
    const sim = makeSim({
      onInvoiceRead: ({ ids }) => ids === PARENT
        ? new Response(JSON.stringify({ data: [{ id: PARENT, syncStatus: statuses.shift() ?? 'Exported', adjustmentToId: null }] }), { status: 200 })
        : undefined,
    });
    const d = await dry(sim);
    await expect(tool.handler(sim.env, { ...ARGS, dryRun: false, confirmation_token: d.confirmation_token }, CTX))
      .rejects.toThrow(/args changed since dryRun/);
    expect(sim.posts).toHaveLength(0);
  });

  it('fails on a non-2xx create, carrying the ServiceTitan error text', async () => {
    const sim = makeSim({ onPost: () => new Response(JSON.stringify({ error: 'ST API 400: bad body' }), { status: 400 }) });
    await expect(confirm(sim)).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('ST API 400: bad body') });
  });

  it('treats an HTTP 200 carrying a failure envelope as a failed write', async () => {
    for (const envelope of [{ ok: false, message: 'ST rejected it' }, { success: false, error: 'no' }, { error: 'ST API 409: conflict' }]) {
      const sim = makeSim({ onPost: () => new Response(JSON.stringify(envelope), { status: 200 }) });
      await expect(confirm(sim)).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('failure envelope') });
    }
  });
});

describe('post-write verify-read', () => {
  it('reports verified with the created invoice id and the persisted total', async () => {
    const sim = makeSim();
    const result = await confirm(sim, { parentInvoiceId: PARENT, lineItems: [{ ...LINE, quantity: 2 }] });
    expect(result.verified).toBe(true);
    expect(result.outcome).toEqual({ remotely_verified: true });
    expect(result.adjustmentInvoiceId).toBe(CREATED);
    expect(result.verification).toMatchObject({ adjustmentInvoiceId: CREATED, parentInvoiceId: PARENT, itemsSubmitted: 1, itemsLanded: 1 });
    expect(result.verification.expectedTotal).toBeCloseTo(-2469.12, 2);
    expect(result.verification.actualTotal).toBeCloseTo(-2469.12, 2);
    expect(sim.posts).toHaveLength(1);
  });

  it('flags a zero-item result as unverified silent_noop, naming the created invoice and the parent', async () => {
    const sim = makeSim({ landed: () => null });
    const result = await confirm(sim);
    expect(result.verified).toBe(false);
    expect(result.outcome.remotely_verified).toBe(false);
    expect(result.outcome.code).toBe('silent_noop');
    expect(result.outcome.mismatched_fields).toEqual(['items']);
    expect(result.outcome.note).toContain(String(CREATED));
    expect(result.outcome.note).toContain(String(PARENT));
    expect(result.outcome.note).toMatch(/not deletable|cannot be deleted|NOT deletable/i);
    expect(sim.posts).toHaveLength(1);
  });

  it('flags a partial drop of lines as partial_write, distinct from the zero-item silent_noop', async () => {
    const sim = makeSim({ landed: (items) => items.slice(0, 1) });
    const result = await confirm(sim, { parentInvoiceId: PARENT, lineItems: [LINE, { skuName: 'SKU2', quantity: 1, unitPrice: -5 }] });
    expect(result.verified).toBe(false);
    expect(result.outcome.remotely_verified).toBe(false);
    expect(result.outcome.code).toBe('partial_write');
    expect(result.outcome.mismatched_fields).toEqual(['items']);
    expect(result.outcome.details).toMatchObject({ submitted: 2, landed: 1, adjustmentInvoiceId: CREATED });
    expect(result.outcome.note).toContain(String(CREATED));
    expect(result.outcome.note).toMatch(/dropped 1 line/);
    expect(sim.posts).toHaveLength(1);
  });

  it('reports extra items as unexpected, never as a negative drop', async () => {
    const sim = makeSim({ landed: (items) => [...items, { ...items[0], description: 'extra' }] });
    const result = await confirm(sim);
    expect(result.verified).toBe(false);
    expect(result.outcome.remotely_verified).toBe(false);
    expect(result.outcome.code).not.toBe('silent_noop');
    expect(result.outcome.code).not.toBe('partial_write');
    expect(result.outcome.note).not.toMatch(/dropped -|dropped 0/);
    expect(result.outcome.note).toMatch(/more.*than|unexpected/i);
    expect(result.outcome.note).toContain(String(CREATED));
    expect(result.outcome.details).toMatchObject({ submitted: 1, landed: 2 });
  });

  it('flags a persisted total that differs from what was sent as amount_mismatch', async () => {
    const sim = makeSim({ persistedPrice: () => 0 });
    const result = await confirm(sim);
    expect(result.verified).toBe(false);
    expect(result.outcome.code).toBe('amount_mismatch');
    expect(result.outcome.mismatched_fields).toEqual(['amount']);
    expect(result.outcome.details).toMatchObject({ expected: -1234.56, actual: 0, adjustmentInvoiceId: CREATED });
  });

  it('retries the read, never the POST, when the items show up on a later verify-read', async () => {
    const sim = makeSim({
      onInvoiceRead: ({ ids, postCount, readCount }) =>
        ids === CREATED && postCount > 0 && readCount <= 3
          ? new Response(JSON.stringify({ data: [{ id: CREATED, items: null }] }), { status: 200 })
          : undefined,
    });
    const result = await confirm(sim);
    expect(result.verified).toBe(true);
    expect(sim.posts).toHaveLength(1);
  });

  it('reports verify_unavailable, and does not re-send, when the created invoice never comes back', async () => {
    const sim = makeSim({
      onInvoiceRead: ({ ids, postCount }) => (ids === CREATED && postCount > 0 ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : undefined),
    });
    const result = await confirm(sim);
    expect(result.verified).toBe(false);
    expect(result.outcome.code).toBe('verify_unavailable');
    expect(result.outcome.note).toContain(String(CREATED));
    expect(sim.posts).toHaveLength(1);
  });

  it('reports verify_unavailable when the re-read carries no items field at all', async () => {
    const sim = makeSim({
      onInvoiceRead: ({ ids, postCount }) =>
        ids === CREATED && postCount > 0 ? new Response(JSON.stringify({ data: [{ id: CREATED, syncStatus: 'Pending' }] }), { status: 200 }) : undefined,
    });
    const result = await confirm(sim);
    expect(result.outcome.code).toBe('verify_unavailable');
    expect(result.outcome.note).toContain(String(CREATED));
  });

  it('reports verify_unavailable, naming the parent, when ServiceTitan returns no invoice id', async () => {
    const sim = makeSim({ onPost: () => new Response(JSON.stringify({ success: true, response: { raw: '' } }), { status: 200 }) });
    const result = await confirm(sim);
    expect(result.verified).toBe(false);
    expect(result.outcome.remotely_verified).toBe(false);
    expect(result.outcome.code).toBe('verify_unavailable');
    expect(result.outcome.note).toContain(String(PARENT));
    expect(result.outcome.note).toMatch(/second one|retry/i);
    expect(sim.posts).toHaveLength(1);
  });
});

describe('registration, description and roles', () => {
  it('is a staff write in the public registry, hidden from readonly and lockdown roles', () => {
    const found = PUBLIC_TOOLS.find((t) => t.name === 'st_create_adjustment_invoice');
    expect(found).toBeDefined();
    expect(found!.isWrite).toBe(true);
    expect(found!.permission).toBe('staff');
    for (const role of ['readonly', 'lockdown'] as const) {
      expect(filterToolsForRole(PUBLIC_TOOLS, role).some((t) => t.name === 'st_create_adjustment_invoice')).toBe(false);
    }
    expect(filterToolsForRole(PUBLIC_TOOLS, 'default' as any).some((t) => t.name === 'st_create_adjustment_invoice')).toBe(true);
  });

  it('no longer lists sku-resolve as cut from release 1', () => {
    expect(CUT_FROM_RELEASE_1).not.toHaveProperty('sku-resolve');
  });

  it('states that adjustment invoices cannot be deleted through the API and that SKUs are checked live', () => {
    expect(tool.description).toMatch(/NOT deletable via the API/);
    expect(tool.description).toMatch(/pricebook/i);
    expect(tool.description).toMatch(/could not be verified|cannot be verified|fail/i);
    expect(tool.description).not.toMatch(/mirror|D1/);
    expect(tool.description).toMatch(/pricebook code/i);
    expect(tool.description).toMatch(/display name/i);
    expect(tool.description).toMatch(/ambiguous|more than one/i);
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
      tokens: base.tokens,
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
              const [id, owner, role, toolName, args_hash, state] = captured as string[];
              if (ops.has(id)) return { success: true, meta: { changes: 0 } };
              ops.set(id, { id, owner, role, tool: toolName, args_hash, state, instance_id: null, result: null, updated_at: Date.now() });
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

  function registryCall(sim: ReturnType<typeof makeSim>) {
    const env = sim.env;
    env.DB = opsDB();
    env.MCP_METRICS = { writeDataPoint: vi.fn() };
    env.ST_RATE_LIMITER = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }),
    };
    const registrations: Array<{ name: string; handler: (args: any, extra?: any) => Promise<any> }> = [];
    const server: any = { registerTool: (name: string, _c: unknown, handler: any) => registrations.push({ name, handler }) };
    registerTool(server, tool as any, env, { waitUntil: () => undefined } as any, { actor: 'reg-test', role: 'default', principal: 'p1' } as any);
    return registrations.find((r) => r.name === 'st_create_adjustment_invoice')!.handler;
  }

  it('a verified write lands as state verified, and a replay of the token makes no second POST', async () => {
    const sim = makeSim();
    const call = registryCall(sim);
    const d = (await call({ ...ARGS, dryRun: true })).structuredContent;
    expect(d.dryRun).toBe(true);
    const confirmArgs = { ...ARGS, dryRun: false, confirmation_token: d.confirmation_token };

    const first = (await call(confirmArgs)).structuredContent;
    expect(first.state).toBe('verified');
    expect(first.verified).toBe(true);
    expect(first.adjustmentInvoiceId).toBe(CREATED);
    expect(first.operation_id).toEqual(expect.any(String));
    expect(sim.posts).toHaveLength(1);

    const replay = (await call(confirmArgs)).structuredContent;
    expect(replay.operation_id).toBe(first.operation_id);
    expect(sim.posts).toHaveLength(1);
  });

  it('a zero-item result lands as outcome-unknown and still carries the code and the created invoice id', async () => {
    const sim = makeSim({ landed: () => null });
    const call = registryCall(sim);
    const d = (await call({ ...ARGS, dryRun: true })).structuredContent;
    const live = (await call({ ...ARGS, dryRun: false, confirmation_token: d.confirmation_token })).structuredContent;
    expect(live.state).toBe('outcome-unknown');
    expect(live.verified).toBe(false);
    expect(live.outcome.code).toBe('silent_noop');
    expect(live.outcome.details).toMatchObject({ adjustmentInvoiceId: CREATED });
    expect(sim.posts).toHaveLength(1);
  });
});
