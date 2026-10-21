import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { st_add_invoice_line_item } from '../st_add_invoice_line_item';
import { extractEntityId, moneyEquals, proxyEnvelopeError, toMoney, unverifiedOutcome } from '../invoice-verify';
import { McpError } from '../../../errors';
import { PUBLIC_TOOLS } from '../../public-registry';
import { filterToolsForRole } from '../../role-filter';
import { registerTool } from '../../../tool-registry';
import { operationStatus } from '../../../operations';

const CTX = { actor: 'vitest', correlation: 'test-corr' };
const TENANT = '000000000';
const ITEMS_ENDPOINT = `/accounting/v2/tenant/${TENANT}/invoices/111/items`;

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

// ── ServiceTitan simulator ───────────────────────────────────
// The invoice read reflects the writes already made, because the tool verifies
// by re-reading. A static mock cannot tell "the money landed" from "HTTP 200
// and nothing happened". The read side serializes numbers as strings, the way
// the live API does: price "-1234.56", quantity "1.0000000000000000000".
// The items PATCH answers with an empty body, so no item id comes back.
interface SimItem { id: number; skuName?: string; description?: string; quantity?: number; cost?: number; price: number }

function serializeItem(it: SimItem) {
  return {
    id: it.id,
    skuName: it.skuName,
    description: it.description,
    quantity: it.quantity !== undefined ? it.quantity.toFixed(19) : undefined,
    cost: it.cost !== undefined ? it.cost.toFixed(10) : undefined,
    price: it.price.toFixed(2),
  };
}

interface SimOpts {
  invoice?: Record<string, unknown>;
  items?: SimItem[];
  /** Override the write outcome for call N (1-based). */
  onWrite?: (call: number, payload: any) => Response | undefined;
  /** Override the invoice read (simulates lag, dropped effects, a 404). */
  onRead?: (state: { writeCount: number; readCount: number; items: SimItem[]; ids: number }) => Response | undefined;
  /** Model ST recomputing or zeroing the submitted price when it persists. */
  persistedPrice?: (payload: any) => number;
}

function makeSim(opts: SimOpts = {}) {
  const invoice = { id: 111, syncStatus: 'Pending', customer: { id: 5 }, ...(opts.invoice ?? {}) };
  const items: SimItem[] = (opts.items ?? []).map((i) => ({ ...i }));
  let nextItemId = 9001;
  let writeCount = 0;
  let readCount = 0;
  const writeCalls: any[] = [];

  const env: any = {
    ST_TRANSPORT: {
      // Direct calls pass (url, init); the registry passes a Request.
      fetch: vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname === '/api/st/write') {
          const raw = typeof input === 'string' ? String(init!.body) : await input.text();
          const body = JSON.parse(raw);
          writeCalls.push(body);
          writeCount++;
          const override = opts.onWrite?.(writeCount, body.payload);
          if (override) return override;
          const p = body.payload;
          const price = opts.persistedPrice ? opts.persistedPrice(p) : (p.unitPrice ?? 0);
          if (p.id !== undefined) {
            const existing = items.find((it) => it.id === p.id);
            if (existing) {
              if (p.description !== undefined) existing.description = p.description;
              if (p.quantity !== undefined) existing.quantity = p.quantity;
              if (p.cost !== undefined) existing.cost = p.cost;
              if (p.unitPrice !== undefined || opts.persistedPrice) existing.price = price;
            }
          } else {
            items.push({ id: nextItemId++, skuName: p.skuName, description: p.description, quantity: p.quantity, cost: p.cost, price });
          }
          return new Response(JSON.stringify({ success: true, endpoint: body.endpoint, method: body.method, response: { raw: '' } }), { status: 200 });
        }
        readCount++;
        const ids = Number(new URL(url.searchParams.get('endpoint') ?? '/', 'https://x.invalid').searchParams.get('ids'));
        const override = opts.onRead?.({ writeCount, readCount, items, ids });
        if (override) return override;
        return new Response(JSON.stringify({ data: [{ ...invoice, items: items.map(serializeItem), subTotal: '0', total: '0' }] }), { status: 200 });
      }),
    },
    ST_TENANT_ID: TENANT,
    CONFIRMATION_SIGNING_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeStatefulDB(),
    STATE_KV: {},
    // Test seam. Production waits 2s then 10s between verify-reads.
    VERIFY_BACKOFF_MS: [0, 0],
  };
  return { env, writeCalls, items, get writeCount() { return writeCount; }, get readCount() { return readCount; } };
}

async function runConfirm(env: any, args: any) {
  const dr: any = await st_add_invoice_line_item.handler(env, args, CTX);
  return st_add_invoice_line_item.handler(env, { ...args, dryRun: false, confirmation_token: dr.confirmation_token }, CTX) as Promise<any>;
}

const APPEND = { skuName: 'SKU1', description: 'HVAC Install', quantity: 1, unitPrice: 100 };

describe('validation', () => {
  it('rejects an empty lineItems list', async () => {
    const sim = makeSim();
    await expect(st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [] }, CTX)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rejects an append (no id) without skuId or skuName', async () => {
    const sim = makeSim();
    await expect(
      st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [{ description: 'no sku', quantity: 1, unitPrice: 10 }] }, CTX),
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('skuId') });
  });

  it('rejects an append without unitPrice, because an appended line with no price lands at $0.00', async () => {
    const sim = makeSim();
    await expect(
      st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [{ skuName: 'SKU1', description: 'x', quantity: 1 }] }, CTX),
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringMatching(/unitPrice/) });
    expect(sim.writeCount).toBe(0);
  });

  it('allows an update (id present) without a sku', async () => {
    const sim = makeSim();
    const result: any = await st_add_invoice_line_item.handler(
      sim.env, { invoiceId: 111, lineItems: [{ id: 999, description: 'update', quantity: 2, unitPrice: 50 }] }, CTX,
    );
    expect(result.dryRun).toBe(true);
  });

  it('warns, without blocking, when an update omits unitPrice or cost', async () => {
    const sim = makeSim();
    const result: any = await st_add_invoice_line_item.handler(
      sim.env, { invoiceId: 111, lineItems: [{ id: 999, description: 'update', quantity: 2 }] }, CTX,
    );
    expect(result.dryRun).toBe(true);
    expect(result.warnings.some((w: string) => /unitPrice/.test(w) && /999/.test(w))).toBe(true);
    expect(result.warnings.some((w: string) => /cost/.test(w))).toBe(true);
  });

  it('schema rejects `price` with a message naming unitPrice, and rejects unknown keys', () => {
    const schema = z.object(st_add_invoice_line_item.zodSchema);
    const base = { invoiceId: 1, lineItems: [{ skuName: 'A', description: 'a', quantity: 1, unitPrice: 5 }] };
    expect(schema.safeParse(base).success).toBe(true);
    const withPrice = schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], price: 5 }] });
    expect(withPrice.success).toBe(false);
    expect(JSON.stringify((withPrice as any).error.issues)).toContain('unitPrice');
    expect(schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], taxable: true }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, lineItems: [{ ...base.lineItems[0], skuName: '' }] }).success).toBe(false);
  });
});

describe('dry run', () => {
  it('reads the invoice, makes no write, and returns a token and one preview step per item', async () => {
    const sim = makeSim();
    const lineItems = [
      { skuId: 501, description: 'Item A', quantity: 1, unitPrice: 10 },
      { skuId: 502, description: 'Item B', quantity: 2, cost: 10, unitPrice: 20 },
      { skuId: 503, description: 'Item C', quantity: 3, technicianId: 9, unitPrice: -30 },
    ];
    const dry: any = await st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems }, CTX);
    expect(dry.dryRun).toBe(true);
    expect(dry.tool).toBe('st_add_invoice_line_item');
    expect(dry.confirmation_token).toMatch(/^st_add_invoice_line_item\|/);
    expect(dry.warnings).toEqual([]);
    expect(sim.writeCount).toBe(0);
    expect(sim.readCount).toBe(1);
    expect(dry.payload.steps).toHaveLength(3);
    dry.payload.steps.forEach((step: any, i: number) => {
      expect(step.call).toBe(i + 1);
      expect(step.endpoint).toBe(ITEMS_ENDPOINT);
      expect(step.method).toBe('PATCH');
      expect(step.payload).toEqual(lineItems[i]);
    });
    expect(dry.payload.steps[2].payload.unitPrice).toBe(-30);
  });

  it('warns about an Exported invoice and still lets the write proceed', async () => {
    const sim = makeSim({ invoice: { syncStatus: 'Exported' } });
    const args = { invoiceId: 111, lineItems: [APPEND] };
    const dry: any = await st_add_invoice_line_item.handler(sim.env, args, CTX);
    expect(dry.warnings.some((w: string) => w.includes('Exported'))).toBe(true);
    const live = await st_add_invoice_line_item.handler(sim.env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX) as any;
    expect(live.dryRun).toBe(false);
    expect(sim.writeCount).toBe(1);
  });

  it('returns a clean not_found tool error when the invoice is missing', async () => {
    const sim = makeSim({ onRead: () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
    await expect(st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [APPEND] }, CTX))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns a clean not_found tool error when ServiceTitan answers 404 on the read', async () => {
    const sim = makeSim({ onRead: () => new Response('missing', { status: 404 }) });
    const err: any = await st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [APPEND] }, CTX).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('not_found');
    expect(sim.writeCount).toBe(0);
  });

  it('fails when the ids filter is not honored on the pre-write read', async () => {
    const sim = makeSim({ invoice: { id: 222 } });
    await expect(st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [APPEND] }, CTX))
      .rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('ids filter not honored') });
  });
});

describe('confirm', () => {
  it('PATCHes the items endpoint once per line item with a flat body', async () => {
    const lineItems = [
      { skuId: 501, description: 'Item A', quantity: 1, unitPrice: 10 },
      { skuId: 502, description: 'Item B', quantity: 2, cost: 10, unitPrice: 20 },
      { skuId: 503, description: 'Item C', quantity: 3, technicianId: 9, unitPrice: 30 },
    ];
    const sim = makeSim();
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems });
    expect(result.dryRun).toBe(false);
    expect(result.result.itemsWritten).toBe(3);
    expect(sim.writeCalls).toHaveLength(3);
    sim.writeCalls.forEach((c, i) => {
      expect(c.endpoint).toBe(ITEMS_ENDPOINT);
      expect(c.method).toBe('PATCH');
      expect(c.payload).toEqual(lineItems[i]);
      expect(Array.isArray(c.payload)).toBe(false);
      expect(c.payload).not.toHaveProperty('items');
    });
  });

  it('keeps unitPrice and skuId on the wire and never emits `price`', async () => {
    const sim = makeSim();
    const args: any = { invoiceId: 111, lineItems: [{ skuId: 7, skuName: 'SKU1', description: 'x', quantity: 1, unitPrice: 100, price: 999 }] };
    await runConfirm(sim.env, args);
    expect(sim.writeCalls[0].payload).not.toHaveProperty('price');
    expect(sim.writeCalls[0].payload.unitPrice).toBe(100);
    expect(sim.writeCalls[0].payload.skuId).toBe(7);
  });

  it('preserves a negative unitPrice on the wire', async () => {
    const sim = makeSim();
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ skuName: 'SKU1', description: 'Offset', quantity: 1, unitPrice: -1234.56 }] });
    expect(sim.writeCalls[0].payload.unitPrice).toBe(-1234.56);
    expect(result.verified).toBe(true);
    expect(result.result.actualAppendedAmount).toBe(-1234.56);
  });

  it('rejects a token minted for different line items before any write', async () => {
    const sim = makeSim();
    const dry: any = await st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [APPEND] }, CTX);
    await expect(
      st_add_invoice_line_item.handler(
        sim.env, { invoiceId: 111, lineItems: [{ ...APPEND, unitPrice: 9999 }], dryRun: false, confirmation_token: dry.confirmation_token }, CTX,
      ),
    ).rejects.toThrow(/args changed/);
    expect(sim.writeCount).toBe(0);
  });

  it('rejects a token minted for a different invoice before any write', async () => {
    const sim = makeSim({ onRead: ({ ids }) => new Response(JSON.stringify({ data: [{ id: ids, syncStatus: 'Pending', items: [] }] }), { status: 200 }) });
    const dry: any = await st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [APPEND] }, CTX);
    await expect(
      st_add_invoice_line_item.handler(
        sim.env, { invoiceId: 112, lineItems: [APPEND], dryRun: false, confirmation_token: dry.confirmation_token }, CTX,
      ),
    ).rejects.toThrow(/args changed/);
    expect(sim.writeCount).toBe(0);
  });

  it('requires a confirmation_token when dryRun is false', async () => {
    const sim = makeSim();
    await expect(st_add_invoice_line_item.handler(sim.env, { invoiceId: 111, lineItems: [APPEND], dryRun: false }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect(sim.writeCount).toBe(0);
  });

  it('rejects the confirm when syncStatus changed between preview and confirm', async () => {
    let statuses = ['Pending', 'Exported'];
    const sim = makeSim({
      onRead: () => new Response(JSON.stringify({ data: [{ id: 111, syncStatus: statuses.shift() ?? 'Exported', items: [] }] }), { status: 200 }),
    });
    const args = { invoiceId: 111, lineItems: [APPEND] };
    const dry: any = await st_add_invoice_line_item.handler(sim.env, args, CTX);
    await expect(
      st_add_invoice_line_item.handler(sim.env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX),
    ).rejects.toThrow(/args changed since dryRun/);
    expect(sim.writeCount).toBe(0);
  });

  it('partial failure names the already-written count and the DELETE endpoint, and stops', async () => {
    const lineItems = [
      { skuId: 501, description: 'A', quantity: 1, unitPrice: 10 },
      { skuId: 502, description: 'B', quantity: 2, unitPrice: 20 },
      { skuId: 503, description: 'C', quantity: 3, unitPrice: 30 },
    ];
    const sim = makeSim({
      items: [{ id: 700, description: 'pre-existing', quantity: 1, price: 5 }],
      onWrite: (call) => (call >= 3 ? new Response(JSON.stringify({ error: 'ST API 400: bad item' }), { status: 400 }) : undefined),
    });
    // Items 1 and 2 are already written, so this is returned as an unverified
    // outcome (not thrown) and reaches the operation record.
    const res: any = await runConfirm(sim.env, { invoiceId: 111, lineItems });
    expect(res.verified).toBe(false);
    expect(res.outcome.remotely_verified).toBe(false);
    expect(res.outcome.code).toBe('upstream_error');
    expect(res.outcome.note).toMatch(/2 items.*already written/i);
    expect(res.outcome.note).toContain('DELETE /accounting/v2/tenant/000000000/invoices/111/items/{itemId}');
    expect(res.outcome.note).toContain('ST API 400: bad item');
    expect(res.outcome.note).toMatch(/baseline item ids \[700\]/);
    expect(res.outcome.details).toMatchObject({
      invoiceId: 111, failedAtCall: 3, itemsWritten: 2, writtenItemIds: [], baselineItemIds: [700],
      deleteEndpoint: '/accounting/v2/tenant/000000000/invoices/111/items/{itemId}',
    });
    expect(sim.writeCount).toBe(3);
  });

  it('partial failure carries written item ids when the envelope returns them', async () => {
    const sim = makeSim({
      onWrite: (call) => call === 1
        ? new Response(JSON.stringify({ success: true, response: { id: 9001 } }), { status: 200 })
        : new Response(JSON.stringify({ error: 'ST API 400' }), { status: 400 }),
    });
    const res: any = await runConfirm(sim.env, {
      invoiceId: 111,
      lineItems: [{ skuId: 501, description: 'A', quantity: 1, unitPrice: 10 }, { skuId: 502, description: 'B', quantity: 1, unitPrice: 20 }],
    });
    expect(res.outcome.details.writtenItemIds).toEqual([9001]);
    expect(res.outcome.note).toContain('9001');
  });

  it('a failure on the first call still throws, since nothing was written', async () => {
    const sim = makeSim({ onWrite: () => new Response(JSON.stringify({ error: 'ST API 500' }), { status: 500 }) });
    await expect(runConfirm(sim.env, { invoiceId: 111, lineItems: [APPEND, APPEND] }))
      .rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('No items were written') });
    expect(sim.writeCount).toBe(1);
  });

  it('treats an HTTP 200 carrying a failure envelope as a failed write', async () => {
    for (const envelope of [{ ok: false, message: 'ST rejected the item' }, { success: false, error: 'no' }, { error: 'ST API 409: conflict' }]) {
      const sim = makeSim({ onWrite: () => new Response(JSON.stringify(envelope), { status: 200 }) });
      await expect(runConfirm(sim.env, { invoiceId: 111, lineItems: [APPEND] }))
        .rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('failure envelope') });
    }
  });
});

describe('post-write verify-read', () => {
  it('reports verified with the observed item ids and persisted amount, by delta against the baseline', async () => {
    const sim = makeSim({ items: [{ id: 700, price: 5, quantity: 1 }] });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ ...APPEND, quantity: 2 }] });
    expect(result.verified).toBe(true);
    expect(result.outcome).toEqual({ remotely_verified: true });
    expect(result.result.appendedItemIds).toEqual([9001]);
    expect(result.result.expectedAppendedAmount).toBe(200);
    expect(result.result.actualAppendedAmount).toBe(200);
    expect(sim.writeCount).toBe(1);
  });

  it('retries the read, never the write, when the appended item shows up on the second verify-read', async () => {
    const sim = makeSim({
      onRead: ({ writeCount, readCount }) =>
        writeCount > 0 && readCount === 3
          ? new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Pending', items: [] }] }), { status: 200 })
          : undefined,
    });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ ...APPEND, unitPrice: 9771 }] });
    expect(result.verified).toBe(true);
    expect(result.result.actualAppendedAmount).toBe(9771);
    expect(sim.writeCount).toBe(1);
    expect(sim.readCount).toBeGreaterThanOrEqual(4);
  });

  it('reports silent_noop as unverified when the write returns 200 and the re-read shows no new item', async () => {
    const sim = makeSim({ onWrite: () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }) });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [APPEND] });
    expect(result.verified).toBe(false);
    expect(result.outcome.remotely_verified).toBe(false);
    expect(result.outcome.code).toBe('silent_noop');
    expect(result.outcome.mismatched_fields).toEqual(['items']);
    expect(result.outcome.note).toContain('111');
    expect(sim.writeCount).toBe(1);
  });

  it('reports amount_mismatch as unverified, naming the created item, when ST zeroes the submitted unitPrice', async () => {
    const sim = makeSim({ persistedPrice: () => 0 });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ ...APPEND, unitPrice: 9771 }] });
    expect(result.verified).toBe(false);
    expect(result.outcome.remotely_verified).toBe(false);
    expect(result.outcome.code).toBe('amount_mismatch');
    expect(result.outcome.mismatched_fields).toEqual(['amount']);
    expect(result.outcome.details).toMatchObject({ expected: 9771, actual: 0, appendedItemIds: [9001] });
  });

  it('reports verify_unavailable, and does not re-send the write, when the re-read comes back empty', async () => {
    const sim = makeSim({ onRead: ({ writeCount }) => (writeCount > 0 ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : undefined) });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [APPEND] });
    expect(result.verified).toBe(false);
    expect(result.outcome.code).toBe('verify_unavailable');
    expect(result.outcome.mismatched_fields).toBeUndefined();
    expect(sim.writeCount).toBe(1);
  });

  it('reports verify_unavailable when the re-read carries no items field at all', async () => {
    const sim = makeSim({
      onRead: ({ writeCount }) => (writeCount > 0 ? new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Pending' }] }), { status: 200 }) : undefined),
    });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [APPEND] });
    expect(result.outcome.code).toBe('verify_unavailable');
  });

  it('reports verify_unavailable when the re-read returns a different invoice id', async () => {
    const sim = makeSim({
      onRead: ({ writeCount, items }) =>
        writeCount > 0 ? new Response(JSON.stringify({ data: [{ id: 999, syncStatus: 'Pending', items }] }), { status: 200 }) : undefined,
    });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [APPEND] });
    expect(result.outcome.code).toBe('verify_unavailable');
    expect(result.outcome.note).toContain('ids filter not honored');
  });

  it('reports verified for an update that ST honors', async () => {
    const sim = makeSim({ items: [{ id: 700, description: 'HVAC Install', quantity: 1, cost: 5000, price: 0 }] });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ id: 700, description: 'HVAC Install', quantity: 1, unitPrice: 9771, cost: 5000 }] });
    expect(result.verified).toBe(true);
    expect(result.result.updatedItemIds).toEqual([700]);
  });

  it('reports amount_mismatch when an update price is not honored', async () => {
    const sim = makeSim({ items: [{ id: 700, description: 'HVAC Install', quantity: 1, price: 0 }], persistedPrice: () => 1 });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ id: 700, description: 'HVAC Install', quantity: 1, unitPrice: 9771 }] });
    expect(result.verified).toBe(false);
    expect(result.outcome.code).toBe('amount_mismatch');
  });

  it('detects an update without unitPrice that ST bound as null and zeroed (compared with the pre-write baseline)', async () => {
    const sim = makeSim({ items: [{ id: 700, description: 'HVAC Install', quantity: 1, price: 9771 }], persistedPrice: () => 0 });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ id: 700, description: 'HVAC Install (renamed)', quantity: 1 }] });
    expect(result.verified).toBe(false);
    expect(result.outcome.code).toBe('amount_mismatch');
    expect(result.outcome.details).toMatchObject({ before: 9771, after: 0 });
    expect(result.outcome.note).toMatch(/WITHOUT unitPrice/);
  });

  it('reports verified for an update without unitPrice that leaves the price alone', async () => {
    const sim = makeSim({ items: [{ id: 700, description: 'HVAC Install', quantity: 1, price: 9771 }] });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ id: 700, description: 'HVAC Install (renamed)', quantity: 1 }] });
    expect(result.verified).toBe(true);
  });

  it('reports silent_noop when an updated item is absent from the re-read', async () => {
    const sim = makeSim({
      items: [{ id: 700, description: 'HVAC Install', quantity: 1, price: 9771 }],
      onRead: ({ writeCount }) =>
        writeCount > 0 ? new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Pending', items: [] }] }), { status: 200 }) : undefined,
    });
    const result = await runConfirm(sim.env, { invoiceId: 111, lineItems: [{ id: 700, description: 'x', quantity: 1, unitPrice: 5 }] });
    expect(result.verified).toBe(false);
    expect(result.outcome.code).toBe('silent_noop');
  });

  it.each([
    ['quantity drop', { quantity: '1' }, 'amount_mismatch', 'quantity'],
    ['sku id wipe', { skuId: null }, 'field_mismatch', 'skuId'],
    ['sku name wipe', { skuName: '' }, 'field_mismatch', 'skuName'],
    ['description drop', { description: 'old' }, 'field_mismatch', 'description'],
  ])('reports %s after a successful PATCH', async (_name, change, code, field) => {
    const before = { id: 7, skuId: 8, skuName: 'SVC', description: 'old', quantity: '1', price: '10', cost: '2' };
    const after = { ...before, quantity: '2', description: 'new', ...(change as object) };
    let reads = 0;
    const sim = makeSim({
      onRead: () => new Response(JSON.stringify({ data: [{ id: 111, items: [reads++ < 2 ? before : after] }] }), { status: 200 }),
    });
    const result = await runConfirm(sim.env, {
      invoiceId: 111,
      lineItems: [{ id: 7, skuId: 8, skuName: 'SVC', quantity: 2, description: 'new', unitPrice: 10, cost: 2 }],
    });
    // reads: dry run, confirm baseline, then verify
    expect(result.verified).toBe(false);
    expect(result.outcome.code).toBe(code);
    expect(result.outcome.mismatched_fields).toEqual([field]);
  });

  it('accepts string-typed numeric identity from ST on an update', async () => {
    const before = { id: 7, skuId: 8, skuName: 'SVC', quantity: '1', price: '10', cost: '2', description: 'old' };
    const after = { ...before, skuId: '8', quantity: '2', description: 'new' };
    let reads = 0;
    const sim = makeSim({
      onRead: () => new Response(JSON.stringify({ data: [{ id: 111, items: [reads++ < 2 ? before : after] }] }), { status: 200 }),
    });
    const result = await runConfirm(sim.env, {
      invoiceId: 111,
      lineItems: [{ id: 7, skuId: 8, skuName: 'SVC', quantity: 2, description: 'new' }],
    });
    expect(result.verified).toBe(true);
  });
});

describe('invoice-verify helpers', () => {
  it('toMoney reads numbers and numeric strings only', () => {
    expect(toMoney('9771.00')).toBe(9771);
    expect(toMoney(-5)).toBe(-5);
    expect(toMoney('')).toBeUndefined();
    expect(toMoney('abc')).toBeUndefined();
    expect(toMoney(null)).toBeUndefined();
  });

  it('moneyEquals tolerates half a cent', () => {
    expect(moneyEquals(10, 10.004)).toBe(true);
    expect(moneyEquals(10, 10.02)).toBe(false);
  });

  it('proxyEnvelopeError flags failure envelopes and passes success ones', () => {
    expect(proxyEnvelopeError({ success: true, response: { raw: '' } })).toBeUndefined();
    expect(proxyEnvelopeError({ ok: false, message: 'm' })).toContain('failure envelope');
    expect(proxyEnvelopeError({ error: 'boom' })).toContain('boom');
    expect(proxyEnvelopeError(null)).toBeUndefined();
  });

  it('extractEntityId reads a bare number, a wrapped number, and finds none in an empty body', () => {
    expect(extractEntityId(84)).toBe(84);
    expect(extractEntityId({ success: true, response: 55 })).toBe(55);
    expect(extractEntityId({ response: { id: 9 } })).toBe(9);
    expect(extractEntityId({ success: true, response: { raw: '' } })).toBeUndefined();
  });

  it('unverifiedOutcome builds the remotely_verified:false shape and drops bulky details', () => {
    const out = unverifiedOutcome(new McpError('amount_mismatch', 'wrong', { details: { field: 'quantity', results: [1, 2], expected: 2 } }));
    expect(out).toEqual({
      verified: false,
      outcome: { remotely_verified: false, code: 'amount_mismatch', mismatched_fields: ['quantity'], note: 'wrong', details: { field: 'quantity', expected: 2 } },
    });
  });
});

describe('registration and roles', () => {
  it('is a staff write in the public registry, hidden from readonly and lockdown roles', () => {
    const tool = PUBLIC_TOOLS.find((t) => t.name === 'st_add_invoice_line_item');
    expect(tool).toBeDefined();
    expect(tool!.isWrite).toBe(true);
    expect(tool!.permission).toBe('staff');
    for (const role of ['readonly', 'lockdown'] as const) {
      expect(filterToolsForRole(PUBLIC_TOOLS, role).some((t) => t.name === 'st_add_invoice_line_item')).toBe(false);
    }
    expect(filterToolsForRole(PUBLIC_TOOLS, 'default' as any).some((t) => t.name === 'st_add_invoice_line_item')).toBe(true);
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
    registerTool(server, st_add_invoice_line_item as any, env, { waitUntil: () => undefined } as any, { actor: 'reg-test', role: 'default', principal: 'p1' } as any);
    return registrations.find((r) => r.name === 'st_add_invoice_line_item')!.handler;
  }

  it('a verified write lands as state verified, and a replay of the token makes no second write', async () => {
    const sim = makeSim();
    const call = registryCall(sim);
    const args = { invoiceId: 111, lineItems: [APPEND] };
    const dry = (await call({ ...args, dryRun: true })).structuredContent;
    expect(dry.dryRun).toBe(true);
    const confirmArgs = { ...args, dryRun: false, confirmation_token: dry.confirmation_token };

    const first = (await call(confirmArgs)).structuredContent;
    expect(first.state).toBe('verified');
    expect(first.verified).toBe(true);
    expect(first.operation_id).toEqual(expect.any(String));
    expect(sim.writeCount).toBe(1);

    const replay = (await call(confirmArgs)).structuredContent;
    expect(replay.operation_id).toBe(first.operation_id);
    expect(sim.writeCount).toBe(1);
  });

  it('a verify-read mismatch lands as outcome-unknown and still carries the mismatch detail', async () => {
    const sim = makeSim({ persistedPrice: () => 0 });
    const call = registryCall(sim);
    const args = { invoiceId: 111, lineItems: [APPEND] };
    const dry = (await call({ ...args, dryRun: true })).structuredContent;
    const live = (await call({ ...args, dryRun: false, confirmation_token: dry.confirmation_token })).structuredContent;
    expect(live.state).toBe('outcome-unknown');
    expect(live.verified).toBe(false);
    expect(live.outcome.code).toBe('amount_mismatch');
    expect(sim.writeCount).toBe(1);
  });

  it('a partial failure after a written line lands as outcome-unknown with the written item ids on the record', async () => {
    const sim = makeSim({
      onWrite: (call) => call === 1
        ? new Response(JSON.stringify({ success: true, response: { id: 9001 } }), { status: 200 })
        : call === 2 ? new Response(JSON.stringify({ error: 'ST API 500: server error' }), { status: 500 }) : undefined,
    });
    const call = registryCall(sim);
    const args = {
      invoiceId: 111,
      lineItems: [
        { skuId: 501, description: 'A', quantity: 1, unitPrice: 10 },
        { skuId: 502, description: 'B', quantity: 1, unitPrice: 20 },
        { skuId: 503, description: 'C', quantity: 1, unitPrice: 30 },
      ],
    };
    const dry = (await call({ ...args, dryRun: true })).structuredContent;
    const live = (await call({ ...args, dryRun: false, confirmation_token: dry.confirmation_token })).structuredContent;
    expect(live.state).toBe('outcome-unknown');
    expect(live.outcome.code).toBe('upstream_error');
    expect(sim.writeCount).toBe(2);

    const row = (sim.env.DB as any).ops.get(live.operation_id);
    expect(row.state).toBe('outcome-unknown');
    const stored = JSON.parse(row.result);
    expect(stored.outcome.details).toMatchObject({ failedAtCall: 2, writtenItemIds: [9001], baselineItemIds: [] });

    const status = await operationStatus(sim.env, live.operation_id, row.owner, row.role);
    expect(status.state).toBe('outcome-unknown');
    expect((status as any).result.outcome.details.writtenItemIds).toEqual([9001]);
  });
});
