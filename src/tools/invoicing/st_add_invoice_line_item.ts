// ============================================================
// st_add_invoice_line_item — add or update line item(s) on an existing
// ServiceTitan invoice.
//
// The endpoint and body shape were confirmed by live probing. A 400 response
// leaked the controller signature:
//   InvoicesController.UpdateInvoiceItemsAsync(Int64 invoiceId, InvoiceItemUpdateRequest itemModel)
// so
//   PATCH /accounting/v2/tenant/{tid}/invoices/{invoiceId}/items
// takes a FLAT SINGLE-ITEM object (`InvoiceItemUpdateRequest`) as its body,
// NOT `{ items: [...] }` and NOT an array. ONE item per HTTP call. Adding N
// line items means N sequential PATCH calls to the same endpoint.
//
// WIRE CONTRACT. The only fields ST binds:
//   id, skuId, skuName, description (REQUIRED), quantity (REQUIRED),
//   cost, technicianId, unitPrice
// ASP.NET model binding SILENTLY DROPS any other field and still returns
// HTTP 200. A misspelled or renamed field does not fail, it just does not
// happen. Do not add a field without live-probing it first, and do not spread
// caller input onto the wire: the outbound body is built from the explicit
// allow-list below.
//
// THE MONETARY FIELD IS `unitPrice`, NOT `price`. `price` is one of the
// silently dropped fields: sending it produced a line item at $0.00 behind an
// HTTP 200 that looked like success. `unitPrice` sets the amount and accepts
// NEGATIVE values (that is how an offsetting line is expressed). On the READ
// side ST returns the same value as `price`, so the verify-read reads `price`
// while the wire body writes `unitPrice`.
//
// OMITTING unitPrice IS NOT SAFE ON AN APPEND. ServiceTitan does not compute
// Pricebook Pro dynamic pricing on API-appended invoice items, so an append
// with no monetary field lands at $0.00. An append therefore REQUIRES
// unitPrice and this tool rejects an append without it. Omitting it only means
// something on the UPDATE path (`id` present), where the intent is "leave the
// existing price alone".
//
// UNPROBED: THE UPDATE PATH (`id` present). The endpoint binds a whole
// `InvoiceItemUpdateRequest`; a handler that assigns every bound property
// writes null/0 over an existing value when the field is absent from the body.
// Whether omitting `unitPrice` or `cost` on an update leaves them untouched or
// zeroes them has not been live-probed. This tool therefore (a) warns at
// dryRun when an update omits them, and (b) compares the item's price and cost
// in the post-write verify-read against the pre-write baseline, reporting
// amount_mismatch if ST changed a field the caller never sent.
//
// Confirmed NOT to exist on this model (ignored by model binding with no bind
// error, even with an object or array value): price, generalLedgerAccountId,
// businessUnitId, type, itemType, taxable, inventory, isChargeable, order,
// serviceDate, installedEquipmentId, total, memberPrice, invoiceId. The
// line-item schema is `.strict()`, so any of these arrives as a LOUD
// validation error instead of being silently stripped. `price` above all,
// since it is the field a caller is most likely to send.
//
// This endpoint accepts `skuId`. An adjustment-invoice endpoint's items[] does
// not (it resolves lines by `skuName` only), so the two item shapes are
// deliberately not shared.
//
// JOB-LINK REASSIGNMENT VIA THE API IS NOT POSSIBLE. The parent invoice update
// endpoint, PATCH /accounting/v2/tenant/{tid}/invoices/{id}, has an update
// model containing ONLY `summary`, `dueDate` and `reviewStatus`. Fields like
// `job`, `jobId`, `invoiceConfiguration`, `businessUnitId` and `customerId`
// are ignored with HTTP 200. There is no jobId argument here for that reason:
// callers need an invoice that is ALREADY linked to the target job.
//
// Whether omitting `id` APPENDS a new line item was inferred from the field
// being nullable, then borne out in practice. A wrong append is reversible: ST
// exposes DELETE /accounting/v2/tenant/{tid}/invoices/{invoiceId}/items/{itemId}.
//
// Flow: dryRun=true (default) -> confirmation_token -> dryRun=false -> N
// sequential writes through the backend transport -> POST-WRITE VERIFY-READ
// (invoice-verify.ts). HTTP 200 from the transport is NOT evidence the money
// landed; the re-read is. The verify-read result is returned as `verified` and
// `outcome.remotely_verified` (with `outcome.mismatched_fields` on a mismatch),
// which is the shape the write-recovery layer reads, so a verified write is
// recorded as verified and a mismatch is recorded as outcome-unknown with the
// reason attached.
// ============================================================

import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { backendWrite } from '../../backend';
import { rewriteTenantPlaceholders } from '../../tenant';
import { guardedStFetch } from '../../rate-limit-guard';
import {
  extractEntityId,
  indexItems,
  intendedAmount,
  isVerifyFailure,
  itemAmount,
  itemPrice,
  moneyEquals,
  proxyEnvelopeError,
  reReadInvoiceForVerify,
  toMoney,
  unverifiedOutcome,
  type VerifyInvoiceItem,
} from './invoice-verify';
import type { ToolDef } from '../index';
import type { Env } from '../../env';

export interface InvoiceLineItemInput {
  id?: number;
  skuId?: number;
  skuName?: string;
  description: string;
  quantity: number;
  cost?: number;
  technicianId?: number;
  unitPrice?: number;
}

// Explicit allow-list of the fields ST actually binds on InvoiceItemUpdateRequest.
// The outbound body is BUILT from this list rather than spread from caller
// input, so a renamed, misspelled or extra field can never ride onto the wire
// and get silently dropped behind an HTTP 200. Adding a name here is a claim
// that it was live-probed. The `keyof` annotation makes a rename on
// InvoiceLineItemInput a compile error.
const ST_INVOICE_ITEM_FIELDS: readonly (keyof InvoiceLineItemInput)[] = [
  'id', 'skuId', 'skuName', 'description', 'quantity', 'cost', 'technicianId', 'unitPrice',
];

// `keyof` above catches renames but not deletions: removing a name from the
// list still typechecks and silently stops sending that field. This makes a
// deletion a compile error too.
type _ItemFieldsComplete =
  Exclude<keyof InvoiceLineItemInput, (typeof ST_INVOICE_ITEM_FIELDS)[number]> extends never ? true : never;
const _itemFieldsComplete: _ItemFieldsComplete = true;
void _itemFieldsComplete;

function toStInvoiceItemPayload(item: InvoiceLineItemInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ST_INVOICE_ITEM_FIELDS) {
    const value = item[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

interface Args {
  invoiceId: number;
  lineItems: InvoiceLineItemInput[];
  dryRun?: boolean;
  confirmation_token?: string;
}

// .strict(): an unknown key is a LOUD validation error, not a silent strip.
// `price` is the field a caller reaches for by reflex (every pricebook tool
// uses it) and it is exactly what writes a $0.00 line, so accepting an input
// ST will silently drop is the pattern this tool exists to prevent.
const lineItemSchema = z.object({
  id: z.number().int().positive().optional().describe(
    'Existing ST invoice-item ID to UPDATE. Omit to APPEND a new line item (append requires skuId/skuName AND unitPrice).'
  ),
  skuId: z.number().int().positive().optional().describe('Pricebook SKU ID for this line item (accepted here; NOT accepted by the adjustment endpoint)'),
  skuName: z.string().min(1).optional().describe('SKU display name/code (empty string is rejected, ST would 500 mid-sequence on it)'),
  description: z.string().min(1).describe('Line item description (required by the ST update model)'),
  quantity: z.number().positive().describe('Line item quantity (required by the ST update model)'),
  cost: z.number().optional().describe('Line item cost basis (not the sell price, see unitPrice)'),
  technicianId: z.number().int().positive().optional().describe('Technician ID to attribute this line item to'),
  unitPrice: z.number().optional().describe(
    'Sell price per unit, THE monetary field on this endpoint. ServiceTitan silently IGNORES a field named ' +
    '`price` (it returns HTTP 200 and writes a $0.00 line), so unitPrice is the only way to set the amount. ' +
    'NEGATIVE values are allowed and are how an offsetting/credit line is expressed. REQUIRED when appending ' +
    '(no `id`): ST does NOT compute dynamic pricing on API-appended items, so an append without unitPrice lands ' +
    'at $0.00 and the tool rejects it. On an UPDATE (`id` present) ' +
    'you may omit it to leave the existing price alone, but that is UNPROBED: ST may bind the omitted field as ' +
    'null and zero the line. The tool warns at dryRun and the post-write verify-read reports amount_mismatch if ' +
    'the price moved.'
  ),
  // TOMBSTONE. `price` is declared only so it can be REJECTED with a message
  // that names the replacement. Left undeclared it would still be rejected by
  // .strict(), but with an opaque "unrecognized key" error.
  price: z.any().optional().refine((v) => v === undefined, {
    message:
      '`price` is NOT a field on ServiceTitan\'s InvoiceItemUpdateRequest. ST silently drops it and writes a $0.00 line behind an HTTP 200. Use `unitPrice` instead.',
  }).describe('DO NOT SEND. ST silently drops `price` and writes a $0.00 line. Use `unitPrice`. Any value is rejected.'),
}).strict();

interface RawInvoice {
  id?: number;
  syncStatus?: string;
  customer?: { id?: number };
  items?: VerifyInvoiceItem[] | null;
  [key: string]: unknown;
}

/**
 * Validates the line items and returns any non-blocking warnings.
 * Blocking rules (validation_error):
 *   - at least one line item
 *   - APPEND (no `id`) needs skuId or skuName: ST 500s "Sku (Name:) is not found." otherwise
 *   - APPEND needs unitPrice: no dynamic pricing on API-appended items, so a $0.00 line
 * Warning rules (surfaced in the dryRun result, not blocking):
 *   - UPDATE omitting unitPrice / cost: unprobed null-overwrite risk
 */
function validateLineItems(lineItems: InvoiceLineItemInput[], correlation: string): string[] {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_add_invoice_line_item requires at least one line item', { correlation });
  }
  const warnings: string[] = [];
  for (const [i, item] of lineItems.entries()) {
    const isAppend = item.id === undefined;
    // Omitting `id` routes to ST's append path, which resolves the item by SKU.
    // Without skuId/skuName ST returns HTTP 500 "Sku (Name:) is not found."
    // Reject locally rather than let a 500 through. An item WITH `id` is an
    // update and needs no sku.
    if (isAppend && item.skuId === undefined && item.skuName === undefined) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: appending a new invoice item (no \`id\`) requires skuId or skuName. ST resolves the item by SKU and returns 500 "Sku (Name:) is not found." otherwise. Pass \`id\` instead to update an existing item.`,
        { correlation }
      );
    }
    // An API-appended item with no monetary field on the wire lands at $0.00.
    // ST does not run Pricebook Pro dynamic pricing on API-appended items, so
    // "omit it and let ST price it" is false for this path.
    if (isAppend && item.unitPrice === undefined) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: appending a new invoice item (no \`id\`) requires unitPrice. ServiceTitan does NOT apply dynamic pricing to API-appended items, so an append without unitPrice lands at $0.00 behind an HTTP 200. Pass the explicit dollar amount (negative is allowed for offsetting lines).`,
        { correlation }
      );
    }
    if (!isAppend && item.unitPrice === undefined) {
      warnings.push(
        `lineItems[${i}]: updating item ${item.id} without unitPrice. ST's update model binding is UNPROBED on this point: an omitted field may bind as null and ZERO an existing priced line. The post-write verify-read compares the item's price against its pre-write value and reports amount_mismatch if ST changed it, but the change would already be written. Restate unitPrice to be sure.`
      );
    }
    if (!isAppend && item.cost === undefined) {
      warnings.push(
        `lineItems[${i}]: updating item ${item.id} without cost. Same unprobed null-overwrite risk as unitPrice (the verify-read checks it against the pre-write value).`
      );
    }
  }
  return warnings;
}

// Sends one ST write through the backend transport, gated by the per-family
// rate limiter.
async function stWrite(
  env: Env,
  ctx: { actor: string; correlation: string },
  endpoint: string,
  method: string,
  payload: unknown
): Promise<Response> {
  return guardedStFetch(env, endpoint, () =>
    backendWrite(env, { endpoint, method, payload }, {
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': ctx.correlation,
        'x-actor': ctx.actor,
      },
    })
  );
}

interface VerifiedSummary {
  appendedItemIds: number[];
  updatedItemIds: number[];
  expectedAppendedAmount: number;
  actualAppendedAmount: number;
  invoiceSubTotal: unknown;
  invoiceTotal: unknown;
}

interface VerifyParams {
  env: Env;
  ctx: { actor: string; correlation: string };
  tenant: string;
  invoiceId: number;
  lineItems: InvoiceLineItemInput[];
  baseline: Map<number, VerifyInvoiceItem>;
  writtenItemIds: number[];
  results: unknown[];
}

// Re-reads the invoice and asserts the money landed. Throws McpError with a
// verification code (silent_noop, amount_mismatch, field_mismatch,
// verify_unavailable) when it did not; the caller turns that into an
// unverified outcome. Never re-sends a write.
async function verifyWrite(p: VerifyParams): Promise<VerifiedSummary> {
  const { env, ctx, tenant, invoiceId, lineItems, baseline, writtenItemIds, results } = p;
  const { correlation } = ctx;
  const baselineIds = new Set(baseline.keys());
  const appends = lineItems.filter((li) => li.id === undefined);
  const updates = lineItems.filter((li) => li.id !== undefined);
  const stranded =
    `All ${lineItems.length} PATCH call(s) were sent against invoice ${invoiceId}` +
    (writtenItemIds.length ? ` (item ids returned by ST: ${writtenItemIds.join(', ')})` : '') +
    `; ${appends.length} append(s), ${updates.length} update(s).`;

  // Acceptance predicate: for a write against an EXISTING invoice the row
  // itself returns immediately on every read, so without this the backoff
  // never engages and ordinary read-after-write lag becomes a false
  // silent_noop. Retry until the appended items are visible (or the schedule
  // exhausts, and the last observed row is then adjudicated below).
  const countNewItems = (inv: { items?: VerifyInvoiceItem[] | null }): number =>
    (inv.items ?? []).filter((it) => {
      const id = Number(it.id);
      return Number.isFinite(id) && !baselineIds.has(id);
    }).length;
  const post = await reReadInvoiceForVerify(env, ctx, tenant, invoiceId, {
    tool: 'st_add_invoice_line_item',
    stranded,
    accept: (inv) => Array.isArray(inv.items) && countNewItems(inv) >= appends.length,
  });

  // `items` key ABSENT: the read carried no line-item information and nothing
  // can be concluded (verify_unavailable). `items: null` is different. That is
  // an OBSERVED invoice with zero lines, so appends that "landed" into it were
  // a silent no-op, not an unknown.
  if (post.items === undefined) {
    throw new McpError(
      'verify_unavailable',
      `st_add_invoice_line_item: the write was sent but the verify-read of invoice ${invoiceId} carried no items field, so the monetary effect could not be confirmed. ${stranded} Check the invoice in ServiceTitan before re-running, because a retry would duplicate the lines.`,
      { correlation, details: { invoiceId, writtenItemIds, results } },
    );
  }
  if (post.items === null) {
    if (appends.length > 0) {
      throw new McpError(
        'silent_noop',
        `st_add_invoice_line_item: ${appends.length} line item(s) were PATCHed onto invoice ${invoiceId} and ServiceTitan answered HTTP 200, but the verify-read shows the invoice still has NO line items (items: null). The write was a silent no-op. ${stranded} Nothing landed; do not retry blindly, inspect the invoice first.`,
        { correlation, details: { invoiceId, baselineItemIds: [...baselineIds], results } },
      );
    }
    throw new McpError(
      'silent_noop',
      `st_add_invoice_line_item: item update(s) were PATCHed on invoice ${invoiceId} (HTTP 200) but the verify-read shows the invoice has no line items at all (items: null). ${stranded}`,
      { correlation, details: { invoiceId, results } },
    );
  }

  const postIndex = indexItems(post.items);
  const newItems = post.items.filter((it) => {
    const id = Number(it.id);
    return Number.isFinite(id) && !baselineIds.has(id);
  });
  const appendedItemIds = newItems.map((it) => Number(it.id));

  if (appends.length > 0 && newItems.length === 0) {
    throw new McpError(
      'silent_noop',
      `st_add_invoice_line_item: ${appends.length} line item(s) were PATCHed onto invoice ${invoiceId} and ServiceTitan answered HTTP 200, but the verify-read shows NO new items on the invoice. The write was a silent no-op. ${stranded} Nothing was rolled back and nothing landed; do not retry blindly, inspect the invoice first.`,
      { correlation, details: { invoiceId, baselineItemIds: [...baselineIds], postItemIds: [...postIndex.keys()], results } },
    );
  }
  if (newItems.length !== appends.length) {
    throw new McpError(
      'silent_noop',
      `st_add_invoice_line_item: expected ${appends.length} new line item(s) on invoice ${invoiceId} after the write, but the verify-read shows ${newItems.length} (ids: ${appendedItemIds.join(', ') || 'none'}). The invoice is not in the intended state. ${stranded}`,
      { correlation, details: { invoiceId, appendedItemIds, baselineItemIds: [...baselineIds], results } },
    );
  }

  // Money check on the appended lines: what ST persisted vs what was sent.
  const expectedAppendTotal = appends.reduce((sum, li) => sum + intendedAmount(li), 0);
  const actualAppendTotal = newItems.reduce((sum, it) => sum + itemAmount(it), 0);
  if (!moneyEquals(expectedAppendTotal, actualAppendTotal)) {
    throw new McpError(
      'amount_mismatch',
      `st_add_invoice_line_item: the line(s) landed on invoice ${invoiceId} but the money is wrong. Sent ${expectedAppendTotal}, ServiceTitan persisted ${actualAppendTotal} (item ids ${appendedItemIds.join(', ')}). Pricebook Pro dynamic pricing may have recomputed or zeroed the submitted unitPrice. The items EXIST and are NOT rolled back: fix or delete them (DELETE /accounting/v2/tenant/${tenant}/invoices/${invoiceId}/items/{itemId}), do not re-append.`,
      { correlation, details: { invoiceId, appendedItemIds, expected: expectedAppendTotal, actual: actualAppendTotal, results } },
    );
  }

  // Update path: locate each item by id and compare what was sent. For a field
  // that was NOT sent, compare against the pre-write baseline. That is how an
  // unprobed null-overwrite (the update model zeroing an omitted unitPrice or
  // cost) gets caught instead of shipping as success.
  const updatedItemIds: number[] = [];
  for (const li of updates) {
    const id = li.id as number;
    const after = postIndex.get(id);
    if (!after) {
      throw new McpError(
        'silent_noop',
        `st_add_invoice_line_item: item ${id} was PATCHed on invoice ${invoiceId} (HTTP 200) but is not present in the verify-read of that invoice. ${stranded}`,
        { correlation, details: { invoiceId, itemId: id, postItemIds: [...postIndex.keys()], results } },
      );
    }
    updatedItemIds.push(id);
    const before = baseline.get(id);

    // Quantity is not money: use numeric equality, not half-cent tolerance.
    const expectedQuantity = li.quantity ?? toMoney(before?.quantity);
    const actualQuantity = toMoney(after.quantity);
    if (expectedQuantity !== undefined && actualQuantity !== expectedQuantity) {
      throw new McpError('amount_mismatch',
        `Invoice ${invoiceId} item ${id}: quantity did not persist. The write already occurred; inspect before retrying.`,
        { correlation, details: { invoiceId, itemId: id, field: 'quantity', expected: expectedQuantity, actual: actualQuantity } });
    }
    for (const field of ['skuId', 'skuName', 'description'] as const) {
      const expected = li[field] !== undefined ? li[field] : before?.[field];
      if (expected === undefined) continue; // no observed baseline to compare
      const actual = after[field];
      const matches = field === 'skuId'
        ? (expected == null ? actual == null : toMoney(expected) !== undefined && toMoney(actual) === toMoney(expected))
        : actual === expected;
      if (!matches) {
        throw new McpError('field_mismatch',
          `Invoice ${invoiceId} item ${id}: ${field} changed or was dropped. The write already occurred; inspect before retrying.`,
          { correlation, details: { invoiceId, itemId: id, field } });
      }
    }

    if (li.unitPrice !== undefined) {
      const actual = itemPrice(after);
      if (actual === undefined || !moneyEquals(actual, li.unitPrice)) {
        throw new McpError(
          'amount_mismatch',
          `st_add_invoice_line_item: item ${id} on invoice ${invoiceId} was updated with unitPrice ${li.unitPrice} but the verify-read shows price ${actual ?? 'none'}. ServiceTitan did not honor the submitted amount.`,
          { correlation, details: { invoiceId, itemId: id, field: 'unitPrice', expected: li.unitPrice, actual } },
        );
      }
    } else if (before !== undefined) {
      // unitPrice was NOT sent: ST must have left it alone.
      const beforePrice = itemPrice(before);
      const afterPrice = itemPrice(after);
      if (beforePrice !== undefined && (afterPrice === undefined || !moneyEquals(beforePrice, afterPrice))) {
        throw new McpError(
          'amount_mismatch',
          `st_add_invoice_line_item: item ${id} on invoice ${invoiceId} was updated WITHOUT unitPrice, and ServiceTitan changed the price anyway: ${beforePrice} before, ${afterPrice ?? 'none'} after. This is the unprobed update-model null-overwrite, where an omitted field bound as null. The change is already written. Restore the price with an explicit unitPrice.`,
          { correlation, details: { invoiceId, itemId: id, field: 'unitPrice', before: beforePrice, after: afterPrice } },
        );
      }
    }

    if (li.cost === undefined && before !== undefined) {
      // toMoney, never typeof-number: ST's read side serializes cost as a
      // string ("0.0000000000"), so a typeof check would blind this guard.
      const beforeCost = toMoney(before.cost);
      const afterCost = toMoney(after.cost);
      if (beforeCost !== undefined && (afterCost === undefined || !moneyEquals(beforeCost, afterCost))) {
        throw new McpError(
          'amount_mismatch',
          `st_add_invoice_line_item: item ${id} on invoice ${invoiceId} was updated WITHOUT cost, and ServiceTitan changed the cost anyway: ${beforeCost} before, ${afterCost ?? 'none'} after (unprobed update-model null-overwrite). Restore it with an explicit cost.`,
          { correlation, details: { invoiceId, itemId: id, field: 'cost', before: beforeCost, after: afterCost } },
        );
      }
    }
  }

  return {
    appendedItemIds,
    updatedItemIds,
    expectedAppendedAmount: expectedAppendTotal,
    actualAppendedAmount: actualAppendTotal,
    invoiceSubTotal: post.subTotal,
    invoiceTotal: post.total,
  };
}

export const st_add_invoice_line_item: ToolDef<Args> = {
  permission: 'staff',
  name: 'st_add_invoice_line_item',
  description:
    'Add or update line item(s) on an existing ServiceTitan invoice. dryRun=true (default) returns a ' +
    'confirmation_token; call again with dryRun=false + token to write. Executes as N sequential PATCH calls, ONE per ' +
    'line item. All N ' +
    'calls are shown in the dryRun preview. Job-link reassignment is NOT possible via this or any ST API, ' +
    'so this tool requires an invoice that is already linked to the ' +
    'target job; there is no jobId argument. Set the amount with `unitPrice`, never `price` (silently dropped, $0.00 line); ' +
    'negative is allowed; unitPrice is required when appending because ST applies no dynamic pricing to API-appended items ' +
    '(see the unitPrice field). Unknown fields are rejected, not stripped. After ' +
    'a live write the tool RE-READS the invoice and asserts the money landed. The result reports `verified` and ' +
    '`outcome.remotely_verified`; on a mismatch `outcome.code` is silent_noop / amount_mismatch / field_mismatch / ' +
    'verify_unavailable and the operation is left outcome-unknown (HTTP 200 is not proof). Exported invoices are NOT blocked (warn only); review the dryRun warning before confirming. If item k of N fails ' +
    'mid-sequence (k > 1), prior items are already written and NOT rolled back; the result is returned as outcome-unknown ' +
    '(`outcome.code` upstream_error) and `outcome.details` names the written and baseline item ids and the DELETE endpoint for cleanup. ' +
    'Source: live ST.',
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/accounting/v2/tenant/{tid}/invoices/{invoiceId}/items', source: 'live' },
  zodSchema: {
    invoiceId: z.number().int().positive().describe('ST invoice ID to modify'),
    lineItems: z.array(lineItemSchema).min(1).describe('Line items to add/update on the invoice. One PATCH call is issued per item'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { invoiceId, lineItems, dryRun = true, confirmation_token } = args;
    const itemWarnings = validateLineItems(lineItems, correlation);

    const tenant = env.ST_TENANT_ID;
    const invoiceData = await readST<{ data?: RawInvoice[] }>(
      env, { actor, correlation },
      `/accounting/v2/tenant/${tenant}/invoices`,
      { ids: invoiceId },
    );
    const invoice = invoiceData.data?.[0];
    if (!invoice) throw new McpError('not_found', `invoice ${invoiceId} not found`, { correlation });
    // This endpoint has a history of silently ignoring params. If ST ever
    // ignores `ids`, data[0] would be an arbitrary invoice: fail loudly
    // instead of writing to the wrong invoice.
    if (Number(invoice.id) !== invoiceId)
      throw new McpError('upstream_error', `ids filter not honored: asked ${invoiceId}, got ${invoice.id}`, { correlation });

    let exportWarning: string | undefined;
    if (invoice.syncStatus === 'Exported') {
      exportWarning = `invoice ${invoiceId} has syncStatus=Exported. Writing to it may not reflect correctly in accounting. Consider an adjustment invoice instead. Proceeding anyway per warn-only policy.`;
    }

    const itemsEndpoint = `/accounting/v2/tenant/000000000/invoices/${invoiceId}/items`;

    // Build the outbound bodies ONCE, from the allow-list, and reuse the exact
    // same objects for both the preview and the live calls. What is approved is
    // literally what runs, and nothing outside the confirmed field set can leak
    // onto the wire to be silently dropped by ST.
    const itemPayloads = lineItems.map(toStInvoiceItemPayload);

    // The preview lists ALL N calls as a compound payload, mirroring
    // assign_technicians. It shows the tenant-resolved URL, not the 000000000
    // placeholder, so the approved steps match the executed calls.
    const resolvedEndpoint = rewriteTenantPlaceholders(env, itemsEndpoint);
    const compoundPayload = {
      steps: itemPayloads.map((payload, i) => ({
        call: i + 1,
        endpoint: resolvedEndpoint,
        method: 'PATCH',
        payload,
      })),
    };

    // TOCTOU guard: fold read-derived state into the hashed args so a material
    // change between the dryRun preview and the confirm call (for example the
    // invoice becomes Exported) invalidates the token via the "args changed
    // since dryRun" path in WriteGate.verifyToken, instead of silently
    // executing a write that differs from what was approved.
    // `wireContract` pins the args-to-wire transformation VERSION into the hash
    // so a token minted by a different payload construction cannot cross a
    // deploy boundary and execute a body nobody previewed. Bump this string any
    // time the outbound payload construction changes.
    const businessArgs = {
      wireContract: 'items-patch-unitprice-v2',
      invoiceId, lineItems, syncStatus: invoice.syncStatus,
    };
    const gate = new WriteGate(env);

    if (dryRun) {
      const result = await gate.dryRun(
        'st_add_invoice_line_item', businessArgs, actor, correlation,
        compoundPayload, itemsEndpoint, 'PATCH', 15 * 60 * 1000
      );
      return { ...result, warnings: [...(exportWarning ? [exportWarning] : []), ...itemWarnings] };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_add_invoice_line_item', businessArgs, actor, confirmation_token);

    // BASELINE, taken from the read above (inside the confirm call, not at
    // dryRun time): the item ids and money already on the invoice. Verification
    // is by DELTA against this, never by "an item with this SKU exists", since
    // an invoice can already carry an inert $0 line for the same SKU.
    const baseline = indexItems(invoice.items);
    const baselineIds = new Set(baseline.keys());

    // N sequential calls, one flat item per call. Partial failure is a real,
    // must-report state: ST offers no batch or transactional endpoint here, so
    // items 1..k-1 are already written by the time item k fails, and there is
    // no rollback.
    const results: unknown[] = [];
    const writtenItemIds: number[] = [];
    for (let i = 0; i < itemPayloads.length; i++) {
      const resp = await stWrite(env, { actor, correlation }, resolvedEndpoint, 'PATCH', itemPayloads[i]);
      // On failure the transport's body carries the ST error message. Read it
      // either way; a bare status number is useless when money is involved.
      const rawText = await resp.text().catch(() => '');
      let body: unknown = null;
      try { body = rawText ? JSON.parse(rawText) : null; } catch { body = { raw: rawText.slice(0, 600) }; }
      // A 200 carrying a failure envelope is a failure the status code does
      // not show: the transport's status is not ServiceTitan's outcome.
      const envelopeError = resp.ok ? proxyEnvelopeError(body) : undefined;
      if (!resp.ok || envelopeError) {
        const succeeded = i;
        const cause = envelopeError ?? `${resp.status}${rawText ? ` — ${rawText.slice(0, 600)}` : ''}`;
        const written = succeeded === 0
          ? 'No items were written before the failure. '
          : `${succeeded} item${succeeded === 1 ? '' : 's'} already succeeded before the failure and ${succeeded === 1 ? 'is' : 'are'} ` +
            `ALREADY WRITTEN to the invoice. ${succeeded === 1 ? 'It is' : 'They are'} NOT rolled back, so the invoice is now in a partially-updated state. ` +
            (writtenItemIds.length
              ? `Already-written item ids: ${writtenItemIds.join(', ')}. `
              : `ServiceTitan returned no item id for the already-written item${succeeded === 1 ? '' : 's'}; find them by comparing the invoice against baseline item ids [${[...baselineIds].join(', ') || 'none'}]. `) +
            `To manually clean up an already-written item, use DELETE /accounting/v2/tenant/${tenant}/invoices/${invoiceId}/items/{itemId}.`;
        const failure = new McpError(
          'upstream_error',
          `st_add_invoice_line_item: item ${i + 1} of ${lineItems.length} failed (${cause}) on invoice ${invoiceId}. ${written}`,
          {
            correlation,
            details: {
              invoiceId,
              failedAtCall: i + 1,
              itemsAttempted: lineItems.length,
              itemsWritten: succeeded,
              writtenItemIds,
              baselineItemIds: [...baselineIds],
              results,
              deleteEndpoint: `/accounting/v2/tenant/${tenant}/invoices/${invoiceId}/items/{itemId}`,
            },
          }
        );
        // Nothing written yet: a plain failure, safe to throw.
        if (succeeded === 0) throw failure;
        // Earlier items ARE written. Return the unverified outcome instead of
        // throwing, so the operation record keeps the written and baseline ids
        // and the DELETE hint; a thrown error would collapse to a bare
        // outcome-unknown with none of that detail.
        return {
          dryRun: false,
          tool: 'st_add_invoice_line_item',
          ...unverifiedOutcome(failure),
          result: { itemsAttempted: lineItems.length, itemsWritten: succeeded, writtenItemIds, results },
          warnings: [...(exportWarning ? [exportWarning] : []), ...itemWarnings],
          correlation,
        };
      }
      results.push(body);
      const writtenId = extractEntityId(body);
      if (writtenId !== undefined) writtenItemIds.push(writtenId);
    }

    // ── POST-WRITE VERIFY-READ ────────────────────────────────
    // Everything above proves the transport answered 200. Nothing above proves
    // ServiceTitan persisted a dollar. Re-read and assert. A failed check is
    // returned as an unverified outcome, not thrown: the writes already landed,
    // and the specific code and ids must reach the operation record.
    const warnings = [...(exportWarning ? [exportWarning] : []), ...itemWarnings];
    try {
      const summary = await verifyWrite({
        env, ctx: { actor, correlation }, tenant, invoiceId, lineItems, baseline, writtenItemIds, results,
      });
      return {
        dryRun: false,
        tool: 'st_add_invoice_line_item',
        verified: true,
        outcome: { remotely_verified: true },
        result: { itemsWritten: lineItems.length, ...summary, results },
        warnings,
        correlation,
      };
    } catch (e) {
      if (!isVerifyFailure(e)) throw e;
      return {
        dryRun: false,
        tool: 'st_add_invoice_line_item',
        ...unverifiedOutcome(e),
        result: { itemsWritten: lineItems.length, writtenItemIds, results },
        warnings,
        correlation,
      };
    }
  },
};
