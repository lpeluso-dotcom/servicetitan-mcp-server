// ============================================================
// st_create_adjustment_invoice: create an adjustment invoice against a parent
// invoice (Posted or Exported only), per ServiceTitan's documented behavior
// for adjustment invoices.
//
// Flow: dryRun=true (default) -> confirmation_token -> dryRun=false -> one
// POST through the backend transport -> POST-WRITE VERIFY-READ
// (invoice-verify.ts). HTTP 200 from the transport is NOT evidence the
// adjustment carries any money; the re-read is. The verify result is returned
// as `verified` and `outcome.remotely_verified` (with `outcome.code` and the
// created invoice id on a failure), which is the shape the write-recovery layer
// reads. A failed verify is returned, not thrown: the invoice already exists
// and its id has to reach the operation record.
//
// ENDPOINT and BODY SHAPE were confirmed by live probing:
//   POST /accounting/v2/tenant/{tid}/invoices
//
// +----------------------------------------------------------------------+
// | WIRE CONTRACT: POST /accounting/v2/tenant/{tid}/invoices             |
// | TOP LEVEL accepted:  adjustmentToId (REQUIRED), summary, items       |
// | items[] accepted:    skuName, description, quantity, cost, unitPrice |
// |                                                                      |
// | DANGER: ASP.NET model binding SILENTLY DROPS anything else and still |
// | returns HTTP 200. Known-dropped, do NOT reintroduce:                 |
// |   top level: lineItems, invoiceItems, invoiceDate, businessUnitId    |
// |   items[]:   skuId, price, total, type, generalLedgerAccountId,      |
// |              businessUnitId, technicianId, serviceDate,              |
// |              membershipTypeId                                        |
// | The outbound body is built from the explicit allow-list below rather |
// | than spread from caller input, so a rename can't ride along unseen.  |
// | The line-item schema is `.strict()`, so a dropped-field name arrives |
// | as a LOUD validation error rather than being silently stripped.      |
// +----------------------------------------------------------------------+
//
// TWO SILENT DROPS PRODUCE AN EMPTY, UNDELETABLE INVOICE:
//  1. The line array is `items`, NOT `lineItems`. Sending `lineItems` creates
//     an adjustment invoice with ZERO items and a $0.00 total behind an HTTP
//     200. It is not deletable via the API.
//  2. The monetary field is `unitPrice`, NOT `price`. `price` is dropped and the
//     line lands at $0.00. NEGATIVE unitPrice is allowed and is exactly how an
//     offsetting adjustment line is expressed. On the READ side ServiceTitan
//     returns that value as `price`; the verify-read accounts for the asymmetry.
//
// SKU NAMES ARE RESOLVED BEFORE THE WRITE (sku-resolve.ts), AGAINST THE LIVE
// PRICEBOOK. On the items-PATCH endpoint an unresolvable SKU fails loudly (HTTP
// 500 "Sku (Name:) is not found."); HERE it fails silently: the line is dropped
// and the adjustment is created empty at $0.00, and it CANNOT be deleted via the
// API. A typo'd name is indistinguishable from a missing one to ServiceTitan, so
// presence-validation is not enough: each name is checked on BOTH the preview
// and the confirm call, and anything but a single definite hit blocks. A name that
// does not exist, one that matches more than one pricebook row, and one that could
// not be checked (the live lookup failed or its scan was cut short) are all
// validation errors raised before any token is issued or any POST is sent. This
// tool fails closed on purpose.
//
// WHAT WAS CHECKED IS WHAT IS SENT. Matching is by pricebook code, tolerant of
// case and hyphen variants, so the caller's string can differ from the code that
// matched. The wire body carries the MATCHED ROW'S EXACT CODE in `skuName`, the
// preview shows that same code, and the resolved codes are folded into the token
// hash, so a pricebook change between preview and confirm voids the token.
//
// ASYMMETRY vs. st_add_invoice_line_item: that endpoint ACCEPTS `skuId`; this one
// does NOT. Adjustment lines resolve by `skuName` only. Do not unify the two item
// shapes: the items-PATCH endpoint accepts `skuId` and `technicianId`, and this
// endpoint's items[] silently drops both.
// ============================================================

import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { backendWrite } from '../../backend';
import { PUBLIC_TENANT_ID_PLACEHOLDER, rewriteTenantPlaceholders } from '../../tenant';
import { guardedStFetch } from '../../rate-limit-guard';
import { resolveSkus, type SkuResolution } from './sku-resolve';
import {
  extractEntityId,
  intendedAmount,
  isVerifyFailure,
  itemAmount,
  moneyEquals,
  proxyEnvelopeError,
  reReadInvoiceForVerify,
  unverifiedOutcome,
} from './invoice-verify';
import type { Env } from '../../env';
import type { ToolDef } from '../index';

interface AdjustmentLineItemInput {
  skuName: string;
  description?: string;
  quantity: number;
  cost?: number;
  unitPrice?: number;
}

interface Args {
  parentInvoiceId: number;
  lineItems: AdjustmentLineItemInput[];
  summary?: string;
  offsetAmount?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

// .strict(): an unknown key is a LOUD validation error, not a silent strip.
// `price` and `skuId` are the two a caller reaches for by reflex here, and both
// are silently discarded by ServiceTitan on this endpoint. Accepting an input
// ServiceTitan will drop is the exact pattern this file exists to prevent.
const lineItemSchema = z.object({
  skuName: z.string().trim().min(1).describe(
    'Pricebook CODE of the item (e.g. "SKU1"), not its display name. REQUIRED: ServiceTitan resolves an adjustment line ' +
    'by SKU name. Unlike the invoice-items PATCH endpoint, `skuId` is silently IGNORED here. The code is checked ' +
    'against the live pricebook before the write (an exact code wins; case and hyphen variants such as "ab12" for "AB-12" ' +
    'are accepted when they match one row) and the matched row\'s exact code is what gets sent. A name that matches ' +
    'nothing, or more than one row, is rejected: an unresolvable name would be dropped by ServiceTitan and produce ' +
    'an empty $0.00 adjustment invoice that cannot be deleted via the API.'
  ),
  description: z.string().optional().describe('Line description'),
  quantity: z.number().positive().describe('Line quantity'),
  cost: z.number().optional().describe('Line cost basis (not the sell amount, see unitPrice)'),
  unitPrice: z.number().optional().describe(
    'Sell price per unit, THE monetary field on this endpoint. ServiceTitan silently IGNORES a field named ' +
    '`price` (HTTP 200, $0.00 line). NEGATIVE values are allowed and are how an offsetting adjustment line is ' +
    'expressed, e.g. unitPrice: -100 to back out revenue booked on the parent invoice. Omitting it creates ' +
    'the line at $0.00 (ServiceTitan does not apply dynamic pricing to API-created invoice lines), which is almost never ' +
    'what an adjustment wants, so the tool warns when it is omitted.'
  ),
  // TOMBSTONES. Declared only so they are REJECTED with a message naming the
  // replacement. .strict() alone would reject them with an opaque
  // "unrecognized key" error.
  price: z.any().optional().refine((v) => v === undefined, {
    message:
      '`price` is NOT a field on ServiceTitan\'s adjustment items[] model. ServiceTitan silently drops it and the line lands at $0.00 behind an HTTP 200. Use `unitPrice` instead.',
  }).describe('DO NOT SEND. ServiceTitan silently drops `price` and the line lands at $0.00. Use `unitPrice`. Any value is rejected.'),
  skuId: z.any().optional().refine((v) => v === undefined, {
    message:
      '`skuId` is silently IGNORED by this endpoint (unlike the invoice-items PATCH endpoint, which accepts it). ServiceTitan resolves an adjustment line by SKU NAME. Use `skuName` instead; a line ServiceTitan cannot resolve is dropped and yields an empty $0.00 adjustment invoice that is not deletable via the API.',
  }).describe('DO NOT SEND. ServiceTitan resolves adjustment lines by SKU NAME only and silently drops skuId. Use `skuName`. Any value is rejected.'),
}).strict();

// Explicit allow-list of the fields ServiceTitan actually binds on an adjustment
// items[] element. The outbound body is BUILT from this list, never spread from
// caller input, so nothing outside the confirmed set can reach the wire and be
// silently discarded. Adding a name here is a claim that it was live-probed. The
// `keyof` annotation makes a rename on AdjustmentLineItemInput a compile error.
const ST_ADJUSTMENT_ITEM_FIELDS: readonly (keyof AdjustmentLineItemInput)[] = [
  'skuName', 'description', 'quantity', 'cost', 'unitPrice',
];

// `keyof` above catches renames but not deletions: removing a name from the list
// still typechecks and silently stops sending that field. This makes a deletion
// a compile error too.
type _AdjFieldsComplete =
  Exclude<keyof AdjustmentLineItemInput, (typeof ST_ADJUSTMENT_ITEM_FIELDS)[number]> extends never ? true : never;
const _adjFieldsComplete: _AdjFieldsComplete = true;
void _adjFieldsComplete;

function toStAdjustmentItemPayload(item: AdjustmentLineItemInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ST_ADJUSTMENT_ITEM_FIELDS) {
    const value = item[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

interface RawInvoice {
  id?: number;
  syncStatus?: string;
  adjustmentToId?: number | null;
  [key: string]: unknown;
}

function validateLineItems(lineItems: AdjustmentLineItemInput[], correlation: string): void {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_create_adjustment_invoice requires at least one line item', { correlation });
  }
  // This endpoint's items[] ignores `skuId` entirely and resolves the line by
  // SKU name. Without skuName there is nothing to resolve and the line is
  // dropped, yielding a $0.00 zero-item adjustment invoice behind an HTTP 200.
  // Reject locally instead.
  for (const [i, item] of lineItems.entries()) {
    if (!item.skuName || item.skuName.trim() === '') {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: skuName is required. ServiceTitan resolves adjustment lines by SKU name and silently ignores skuId on this endpoint. Without skuName the line is dropped and the adjustment invoice is created empty at $0.00.`,
        { correlation },
      );
    }
  }
}

type ResolvedSku = Extract<SkuResolution, { status: 'resolved' }>;

/**
 * Resolve every line's skuName against the live pricebook. Anything other than
 * a single definite hit is a validation_error raised BEFORE the write, because
 * the alternative is an undeletable empty $0.00 adjustment invoice. That includes
 * a name that matches more than one row and a lookup that could not run: this
 * check is the only guard, so it fails closed. Returns one resolution per line,
 * in line order.
 */
async function checkSkuNames(
  env: Env,
  ctx: { actor: string; correlation: string },
  lineItems: AdjustmentLineItemInput[],
): Promise<{ resolved: ResolvedSku[] }> {
  const results = await resolveSkus(env, ctx, lineItems.map((li) => li.skuName));
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const unchecked: string[] = [];
  const resolved: ResolvedSku[] = [];
  results.forEach((res, i) => {
    const label = `lineItems[${i}]: skuName "${res.skuName}"`;
    if (res.status === 'resolved') resolved.push(res);
    else if (res.status === 'not_found') missing.push(label);
    else if (res.status === 'ambiguous') ambiguous.push(`${label} (${res.candidates.join('; ')})`);
    else unchecked.push(`${label} (${res.reason})`);
  });
  if (missing.length === 0 && ambiguous.length === 0 && unchecked.length === 0) return { resolved };

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(
      `${missing.join('; ')} matches no pricebook code in the live pricebook (services, materials and equipment; case and hyphen variants were tried; a display name is not accepted).`,
    );
  }
  if (ambiguous.length > 0) {
    parts.push(
      `${ambiguous.join('; ')} matches more than one pricebook row, so the SKU is ambiguous. Pass the exact code of the one you mean.`,
    );
  }
  if (unchecked.length > 0) {
    parts.push(
      `${unchecked.join('; ')} could not be verified against the live pricebook, so it is treated as unresolved.`,
    );
  }
  throw new McpError(
    'validation_error',
    `${parts.join(' ')} ServiceTitan resolves adjustment lines by SKU NAME and silently DROPS a line whose name it cannot resolve. The result is an adjustment invoice with zero items at $0.00, behind an HTTP 200, which is NOT deletable via the API. No confirmation token was issued and nothing was sent. Use search_pricebook_all / search_pricebook_services to find the exact code${unchecked.length > 0 ? ', or retry once the pricebook lookup is available' : ''}.`,
    {
      correlation: ctx.correlation,
      details: { unresolved: results.filter((r) => r.status !== 'resolved') },
    },
  );
}

async function stWrite(
  env: Env,
  ctx: { actor: string; correlation: string },
  endpoint: string,
  payload: unknown,
): Promise<Response> {
  return guardedStFetch(env, endpoint, () =>
    backendWrite(env, { endpoint, method: 'POST', payload }, {
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': ctx.correlation,
        'x-actor': ctx.actor,
      },
    })
  );
}

interface VerifySummary {
  itemsLanded: number;
  expectedTotal: number;
  actualTotal: number;
  invoiceSubTotal: unknown;
  invoiceTotal: unknown;
}

// Re-reads the created invoice and asserts the items and the money landed.
// Throws McpError with a verification code (silent_noop, amount_mismatch,
// verify_unavailable) when they did not; the caller turns that into an unverified
// outcome. Every message names the created invoice id: adjustment invoices cannot
// be deleted through the API, so a stray one nobody can name is the worst outcome.
async function verifyCreated(p: {
  env: Env;
  ctx: { actor: string; correlation: string };
  createdId: number;
  parentInvoiceId: number;
  lineItems: AdjustmentLineItemInput[];
  result: unknown;
}): Promise<VerifySummary> {
  const { env, ctx, createdId, parentInvoiceId, lineItems } = p;
  const { correlation } = ctx;
  const expectedTotal = lineItems.reduce((sum, li) => sum + intendedAmount(li), 0);
  const stranded = `Adjustment invoice ${createdId} WAS created against parent ${parentInvoiceId} and is NOT deletable via the ServiceTitan API. Correct it in the ServiceTitan UI.`;

  // accept: retry through the backoff until the created invoice's items are
  // visible (a brand-new invoice can surface in the list before its lines finish
  // propagating). On exhaustion the last observed row is adjudicated below
  // rather than hidden behind verify_unavailable.
  const post = await reReadInvoiceForVerify(env, ctx, PUBLIC_TENANT_ID_PLACEHOLDER, createdId, {
    tool: 'st_create_adjustment_invoice',
    stranded,
    accept: (inv) => Array.isArray(inv.items) && inv.items.length >= lineItems.length,
  });

  const items = post.items;
  if (items === undefined) {
    throw new McpError(
      'verify_unavailable',
      `st_create_adjustment_invoice: adjustment invoice ${createdId} was created but the verify-read carried no items field, so its contents could not be confirmed. ${stranded}`,
      { correlation, details: { adjustmentInvoiceId: createdId, parentInvoiceId } },
    );
  }
  if (items === null || items.length === 0) {
    throw new McpError(
      'silent_noop',
      `st_create_adjustment_invoice: adjustment invoice ${createdId} was created against parent ${parentInvoiceId} but has ZERO line items. ServiceTitan accepted the request and dropped every line (HTTP 200, items null, total $0.00). ${stranded} Expected ${lineItems.length} line(s) totalling ${expectedTotal}.`,
      { correlation, details: { adjustmentInvoiceId: createdId, parentInvoiceId, expectedItems: lineItems.length, expectedTotal } },
    );
  }
  if (items.length > lineItems.length) {
    throw new McpError(
      'field_mismatch',
      `st_create_adjustment_invoice: adjustment invoice ${createdId} carries more line items than were submitted (${items.length} landed, ${lineItems.length} submitted). The invoice is not in the intended state; inspect it before doing anything else. ${stranded}`,
      { correlation, details: { field: 'items', adjustmentInvoiceId: createdId, parentInvoiceId, submitted: lineItems.length, landed: items.length } },
    );
  }
  if (items.length < lineItems.length) {
    throw new McpError(
      'partial_write',
      `st_create_adjustment_invoice: adjustment invoice ${createdId} carries ${items.length} of the ${lineItems.length} line item(s) submitted. ServiceTitan dropped ${lineItems.length - items.length} line(s) silently (an unresolvable skuName does this), so the invoice is partly written. ${stranded}`,
      { correlation, details: { adjustmentInvoiceId: createdId, parentInvoiceId, submitted: lineItems.length, landed: items.length } },
    );
  }

  const actualTotal = items.reduce((sum, it) => sum + itemAmount(it), 0);
  if (!moneyEquals(actualTotal, expectedTotal)) {
    throw new McpError(
      'amount_mismatch',
      `st_create_adjustment_invoice: adjustment invoice ${createdId} has all ${items.length} line(s) but the money is wrong. Sent ${expectedTotal}, ServiceTitan persisted ${actualTotal}. The offset will NOT net the parent invoice. ${stranded}`,
      { correlation, details: { adjustmentInvoiceId: createdId, parentInvoiceId, expected: expectedTotal, actual: actualTotal } },
    );
  }

  return {
    itemsLanded: items.length,
    expectedTotal,
    actualTotal,
    invoiceSubTotal: post.subTotal,
    invoiceTotal: post.total,
  };
}

export const st_create_adjustment_invoice: ToolDef<Args> = {
  permission: 'staff',
  name: 'st_create_adjustment_invoice',
  description:
    'Create an adjustment invoice against a parent invoice (must be Posted or Exported). ' +
    'dryRun=true (default) returns a confirmation_token; call again with dryRun=false + token to write. ' +
    'Each line needs skuName (skuId is ignored) and unitPrice (`price` is ignored, giving $0.00). skuName is the pricebook code, ' +
    'not the display name. Every skuName is checked against the live ServiceTitan pricebook on both the preview and the ' +
    'confirm call, and the matched pricebook code (which can differ from the input in case or hyphens) is what the preview ' +
    'shows and what is sent. A name that matches no pricebook code, that is ambiguous (matches more than one row), or that could ' +
    'not be verified because the lookup failed is rejected before any token is issued or any write is sent. An inactive ' +
    'pricebook item draws a warning but does not block. Adjustment lines are typically NEGATIVE unitPrice to offset revenue, but sign is not enforced. ' +
    'NOTE: ServiceTitan ignores a ' +
    'business unit or invoice date on this call (the adjustment inherits the parent invoice\'s business unit and is dated by ServiceTitan), ' +
    'so this tool has no businessUnitId/invoiceDate argument. Unknown line fields are rejected, not stripped. After the ' +
    'write the tool RE-READS the created invoice and asserts the items and the total actually landed. The result reports ' +
    '`verified` and `outcome.remotely_verified`; on a mismatch `outcome.code` is silent_noop / partial_write / amount_mismatch / field_mismatch / ' +
    'verify_unavailable and the operation is left outcome-unknown, always naming the created invoice id (HTTP 200 is not proof). ' +
    'Adjustment invoices are NOT deletable via the API; a mistake has to be corrected in the ServiceTitan UI, so review the ' +
    'dryRun preview carefully before confirming. Source: live ST.',
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  zodSchema: {
    parentInvoiceId: z.number().int().positive().describe('ServiceTitan invoice ID being adjusted'),
    lineItems: z.array(lineItemSchema).min(1).describe('Adjustment line items, sent to ServiceTitan as `items`; typically negative unitPrice to offset revenue'),
    summary: z.string().optional().describe('Invoice summary/memo, accepted at the top level by ServiceTitan (e.g. why the adjustment exists)'),
    offsetAmount: z.number().optional().describe('If provided, warns (does not block) when the lineItems total does not net this amount to zero'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
    // TOMBSTONED TOP-LEVEL ARGS. ServiceTitan silently ignores both on this
    // endpoint, so quietly stripping them would tell the caller their business
    // unit / date took effect when it did not.
    businessUnitId: z.any().optional().refine((v) => v === undefined, {
      message:
        'businessUnitId is not supported: ServiceTitan silently ignores it on POST /invoices and the adjustment inherits the parent invoice\'s business unit. Do not send it.',
    }).describe('DO NOT SEND. ServiceTitan silently ignores it and the adjustment inherits the parent invoice\'s business unit. Any value is rejected.'),
    invoiceDate: z.any().optional().refine((v) => v === undefined, {
      message:
        'invoiceDate is not supported: ServiceTitan silently ignores it on POST /invoices and dates the adjustment itself. Do not send it.',
    }).describe('DO NOT SEND. ServiceTitan silently ignores it and dates the adjustment itself. Any value is rejected.'),
  },
  async handler(env, args, { actor, correlation }) {
    const { parentInvoiceId, lineItems, summary, offsetAmount, dryRun = true, confirmation_token } = args;
    const ctx = { actor, correlation };
    validateLineItems(lineItems, correlation);

    // The placeholder is rewritten to the configured tenant by readST and by the
    // write transport path below; it also holds when ST_TENANT_ID is unset.
    const tenant = PUBLIC_TENANT_ID_PLACEHOLDER;
    const parentData = await readST<{ data?: RawInvoice[] }>(
      env, ctx,
      `/accounting/v2/tenant/${tenant}/invoices`,
      { ids: parentInvoiceId },
    );
    const parent = parentData.data?.[0];
    if (!parent) throw new McpError('not_found', `invoice ${parentInvoiceId} not found`, { correlation });
    // This endpoint has a documented history of silently ignoring params. If
    // ServiceTitan ever ignores `ids`, data[0] would be an arbitrary invoice:
    // fail loudly instead of authorizing an adjustment against the wrong invoice.
    if (Number(parent.id) !== parentInvoiceId)
      throw new McpError('upstream_error', `ids filter not honored: asked ${parentInvoiceId}, got ${parent.id}`, { correlation });

    if (parent.syncStatus !== 'Posted' && parent.syncStatus !== 'Exported') {
      throw new McpError(
        'validation_error',
        `invoice ${parentInvoiceId} has syncStatus=${parent.syncStatus}. Adjustment invoices can only be created against Posted or Exported invoices`,
        { correlation },
      );
    }
    if (parent.adjustmentToId) {
      throw new McpError(
        'validation_error',
        `invoice ${parentInvoiceId} is itself an adjustment invoice (adjustmentToId=${parent.adjustmentToId}); adjustment-of-adjustment chains are not supported`,
        { correlation },
      );
    }

    // Runs on BOTH phases: a SKU that disappears between preview and confirm
    // must not slip through into an undeletable empty adjustment, and a lookup
    // that cannot run blocks the write instead of waving it through.
    const skuResolution = await checkSkuNames(env, ctx, lineItems);

    const warnings: string[] = [];
    // An inactive pricebook item may be dropped from a new invoice. Warn, do not
    // block: nothing shows ServiceTitan refuses it, and the verify-read catches a drop.
    for (const r of skuResolution.resolved) {
      if (r.active === false) {
        warnings.push(`SKU ${r.matched} is inactive in the pricebook; ServiceTitan may drop it from a new invoice`);
      }
    }
    // An adjustment line with no unitPrice is created at $0.00: ServiceTitan does
    // not apply dynamic pricing to API-created lines. A $0.00 adjustment offsets
    // nothing.
    lineItems.forEach((li, i) => {
      if (li.unitPrice === undefined) {
        warnings.push(
          `lineItems[${i}] (${li.skuName}): no unitPrice. ServiceTitan will create this adjustment line at $0.00 (no dynamic pricing on API-created lines), so it will not offset anything. Pass an explicit (usually negative) unitPrice.`
        );
      }
    });
    if (offsetAmount !== undefined) {
      const lineTotal = lineItems.reduce((sum, li) => sum + (li.unitPrice ?? 0) * li.quantity, 0);
      if (Math.abs(lineTotal + offsetAmount) > 0.01) {
        warnings.push(`adjustment line total (${lineTotal}) does not net offsetAmount (${offsetAmount}) to zero. Informational only; not all adjustments are full offsets`);
      }
    }

    // The wire carries the MATCHED pricebook code, not the caller's string: the
    // pre-check approved that code, so that is what must be sent.
    const wireItems: AdjustmentLineItemInput[] = lineItems.map((li, i) => ({ ...li, skuName: skuResolution.resolved[i].matched }));

    // Built from the allow-list, NOT spread from args. `items` is the confirmed
    // top-level array name; `lineItems` is silently dropped by ServiceTitan and
    // creates an empty $0.00 adjustment invoice behind an HTTP 200.
    const payload: Record<string, unknown> = {
      adjustmentToId: parentInvoiceId,
      ...(summary !== undefined ? { summary } : {}),
      items: wireItems.map(toStAdjustmentItemPayload),
    };

    // TOCTOU guard: fold read-derived parent state into the hashed args so a
    // material change between the dryRun preview and the confirm call (the
    // parent's syncStatus or adjustmentToId changing) invalidates the token via
    // the "args changed since dryRun" path in WriteGate.verifyToken.
    // `wireContract` pins the args-to-wire transformation VERSION into the hash.
    // WriteGate.hashArgs drops undefined values, so an arg-shape change across a
    // deploy is hash-INVISIBLE when the optionals are absent: a token minted by
    // other code would verify here and execute a wire body nobody previewed.
    // Bump this string any time the outbound payload construction changes.
    const businessArgs = {
      wireContract: 'adjustment-items-v3',
      parentInvoiceId, lineItems, summary, offsetAmount,
      resolvedSkuNames: skuResolution.resolved.map((r) => r.matched),
      syncStatus: parent.syncStatus, adjustmentToId: parent.adjustmentToId,
    };
    const gate = new WriteGate(env);
    const endpoint = `/accounting/v2/tenant/${tenant}/invoices`;

    if (dryRun) {
      const result = await gate.dryRun('st_create_adjustment_invoice', businessArgs, actor, correlation, payload, endpoint, 'POST', 15 * 60 * 1000);
      return { ...result, warnings, skuResolution };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_create_adjustment_invoice', businessArgs, actor, confirmation_token);

    const resolvedEndpoint = rewriteTenantPlaceholders(env, endpoint);
    const resp = await stWrite(env, ctx, resolvedEndpoint, payload);
    // The transport's failure body carries the ServiceTitan error message
    // ({error: "ST API 4xx ..."}). Surface it; a bare status number is useless
    // when money is involved.
    const rawText = await resp.text().catch(() => '');
    if (!resp.ok) {
      throw new McpError(
        'upstream_error',
        `st_create_adjustment_invoice failed: ${resp.status}${rawText ? ` — ${rawText.slice(0, 600)}` : ''}`,
        { correlation, details: { status: resp.status, body: rawText.slice(0, 600) } },
      );
    }
    let result: unknown = null;
    try { result = rawText ? JSON.parse(rawText) : null; } catch { result = { raw: rawText.slice(0, 600) }; }
    // A 200 carrying a failure envelope is a failure the status code does not
    // show: the transport's status is not ServiceTitan's outcome.
    const envelopeError = proxyEnvelopeError(result);
    if (envelopeError) {
      throw new McpError('upstream_error', `st_create_adjustment_invoice failed: ${envelopeError}`, { correlation, details: { result } });
    }

    // ── POST-WRITE VERIFY-READ ────────────────────────────────
    // The create returned 200. That proves nothing about items or dollars: an
    // empty $0.00 invoice is exactly what a dropped field produces. A failed
    // check is returned as an unverified outcome, not thrown: the invoice
    // already exists, and the specific code and invoice id must reach the
    // operation record.
    const createdId = extractEntityId(result);
    const verifiedBase = { dryRun: false as const, tool: 'st_create_adjustment_invoice' };
    try {
      if (createdId === undefined) {
        throw new McpError(
          'verify_unavailable',
          `st_create_adjustment_invoice: ServiceTitan returned HTTP 200 but no invoice id, so the adjustment against parent ${parentInvoiceId} could NOT be verified. AN ADJUSTMENT INVOICE MAY EXIST and adjustment invoices are not deletable via the API. Find it in ServiceTitan under parent ${parentInvoiceId} before re-running, or a retry will create a second one. Raw response: ${JSON.stringify(result).slice(0, 500)}`,
          { correlation, details: { parentInvoiceId } },
        );
      }
      const summaryOut = await verifyCreated({ env, ctx, createdId, parentInvoiceId, lineItems, result });
      return {
        ...verifiedBase,
        verified: true,
        outcome: { remotely_verified: true },
        adjustmentInvoiceId: createdId,
        result,
        verification: {
          adjustmentInvoiceId: createdId,
          parentInvoiceId,
          itemsSubmitted: lineItems.length,
          ...summaryOut,
        },
        warnings,
        skuResolution,
        correlation,
      };
    } catch (e) {
      if (!isVerifyFailure(e)) throw e;
      return {
        ...verifiedBase,
        ...unverifiedOutcome(e),
        ...(createdId !== undefined ? { adjustmentInvoiceId: createdId } : {}),
        result,
        warnings,
        skuResolution,
        correlation,
      };
    }
  },
};
