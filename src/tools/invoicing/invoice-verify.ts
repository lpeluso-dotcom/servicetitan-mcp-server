// ============================================================
// invoice-verify.ts — post-write verify-read helpers for the invoice write
// tools (st_add_invoice_line_item, and any later invoice write).
//
// BIND-SUCCESS IS NOT EFFECT. ServiceTitan's model binding silently drops any
// body field it does not know and still answers HTTP 200. A wrong field name
// (`price` instead of `unitPrice`, `lineItems` instead of `items`) reports
// success while writing a $0.00 line or a zero-item invoice. Neither the
// transport's status code nor a 400-probe bind-echo can tell "ST persisted
// what I sent" from "ST accepted the request and ignored the part that
// mattered". Only a re-read can.
//
// So after any dryRun=false write, the tool re-reads the invoice and asserts
// the MONETARY effect. The checks here throw McpError with one of four codes:
//   silent_noop        effect absent (items missing, item id not found)
//   partial_write      effect partly present (some lines landed, some did not)
//   amount_mismatch    effect present but the money is wrong
//   field_mismatch     effect present but an identity field changed or dropped
//   verify_unavailable could not observe (lag, read error, ids not honored)
// The write tool catches those and reports them as an unverified outcome (see
// unverifiedOutcome) instead of rethrowing: the write already happened, and an
// exception would hide that from the operation record.
//
// READ-SIDE FIELD NAME: on the WRITE side the monetary field is `unitPrice`;
// on the READ side ST returns it as `price`. itemPrice() reads `price` first
// and tolerates `unitPrice` in case a future read model uses the write name.
//
// NEVER auto-retry the write from here. A verify failure means the state is
// unknown or wrong, not that nothing happened. Re-sending is how a line gets
// written twice. Every error raised here names the ids that were created or
// modified, so nothing is stranded invisibly.
// ============================================================

import { McpError, type McpErrorCode } from '../../errors';
import { readST } from '../../st';
import type { Env } from '../../env';

// ST's read side serializes numeric fields as JSON STRINGS ("9771.00",
// "1.0000000000000000000"). Every numeric field here admits both, and all
// comparisons go through toMoney(), never a typeof-number check.
export interface VerifyInvoiceItem {
  id?: number;
  skuId?: number | string | null;
  skuName?: string;
  description?: string;
  quantity?: number | string;
  cost?: number | string;
  /** READ-side monetary field. */
  price?: number | string;
  /** WRITE-side monetary field name; tolerated on read in case ST unifies. */
  unitPrice?: number | string;
  total?: number | string;
  [key: string]: unknown;
}

export interface VerifyInvoice {
  id?: number;
  /**
   * ST returns `items: null` on an invoice with no lines. `undefined` (the key
   * absent altogether) means the read did not carry items at all and NOTHING
   * can be concluded from it: that is verify_unavailable, never silent_noop.
   */
  items?: VerifyInvoiceItem[] | null;
  subTotal?: number | string;
  total?: number | string;
  [key: string]: unknown;
}

/** Half a cent. Invoice money is 2dp, so this is a pure float-noise guard. */
export const MONEY_EPSILON = 0.005;

export function moneyEquals(a: number, b: number): boolean {
  return Math.abs(a - b) <= MONEY_EPSILON;
}

/**
 * Coerce a read-side numeric field to a number, or undefined if absent or
 * junk. Accepts a number or a numeric string; an empty string and non-numeric
 * text give undefined. A typeof-number check would read every live value as
 * absent and make every successful nonzero write look like a mismatch.
 */
export function toMoney(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Monetary value of a read-side invoice item, or undefined if ST sent none. */
export function itemPrice(item: VerifyInvoiceItem): number | undefined {
  return toMoney(item.price) ?? toMoney(item.unitPrice);
}

/** price x quantity for a read-side item; an absent price or quantity counts as 0. */
export function itemAmount(item: VerifyInvoiceItem): number {
  const qty = toMoney(item.quantity) ?? 0;
  return (itemPrice(item) ?? 0) * qty;
}

/** unitPrice x quantity for a submitted (write-side) line. */
export function intendedAmount(line: { unitPrice?: number; quantity: number }): number {
  return (line.unitPrice ?? 0) * line.quantity;
}

/** Index a read-side items array by item id. */
export function indexItems(items: VerifyInvoiceItem[] | null | undefined): Map<number, VerifyInvoiceItem> {
  const map = new Map<number, VerifyInvoiceItem>();
  for (const item of items ?? []) {
    const id = Number(item.id);
    if (Number.isFinite(id)) map.set(id, item);
  }
  return map;
}

/**
 * Read-after-write backoff schedule: 2s then 10s. `env.VERIFY_BACKOFF_MS`
 * overrides it (test seam).
 */
export function verifyBackoffMs(env: Env): number[] {
  const raw = env.VERIFY_BACKOFF_MS;
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) return raw;
  return [2000, 10000];
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Body-level failure check for the write transport's response. A success looks
 * like { success: true, endpoint, method, response: <ST raw response> } and a
 * failure normally arrives as a non-2xx status. This is defense in depth for a
 * 200 whose body still signals failure: `success: false`, an `error` string,
 * or the legacy `ok: false` shape.
 */
export function proxyEnvelopeError(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  if (rec.ok === false || rec.success === false || typeof rec.error === 'string') {
    const detail =
      typeof rec.error === 'string' ? rec.error :
      typeof rec.message === 'string' ? rec.message :
      JSON.stringify(rec).slice(0, 300);
    return `proxy returned HTTP 200 with a failure envelope: ${detail}`;
  }
  return undefined;
}

/**
 * Pull a created entity's id (invoice id, invoice-item id) out of whatever
 * shape ST or the transport returned, to name what was written in error
 * messages. The transport wraps ST's response as { success, endpoint, method,
 * response: <raw> }, and ST's invoice create returns the new id as a bare
 * number, so `rec.response` (bare number or {id}) is the first candidate. The
 * others cover direct-ST shapes. The items PATCH returns an empty body, which
 * correctly yields undefined here; the line-item tool verifies by baseline
 * diff instead.
 */
export function extractEntityId(body: unknown): number | undefined {
  if (typeof body === 'number' || typeof body === 'string') {
    const n = Number(body);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  if (body === null || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const response = rec.response;
  const candidates: unknown[] = [
    typeof response === 'number' || typeof response === 'string' ? response : undefined,
    (response as Record<string, unknown> | undefined)?.id,
    rec.id,
    rec.invoiceId,
    (rec.data as Record<string, unknown> | undefined)?.id,
    (rec.result as Record<string, unknown> | undefined)?.id,
    (rec.invoice as Record<string, unknown> | undefined)?.id,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export interface VerifyContext {
  actor: string;
  correlation: string;
}

/**
 * Re-read an invoice for verification, with the ids-honored guard and the
 * read-after-write backoff. Throws `verify_unavailable` (never silent_noop)
 * when the invoice cannot be observed. The write may still have landed, so
 * `stranded` MUST describe exactly what was written so the operator can find
 * it. The write is never re-sent from here.
 *
 * `accept` extends the backoff to ITEM-LEVEL lag: for a write against an
 * EXISTING invoice the row itself comes back immediately on every read, so
 * without a predicate the backoff never engages and the caller's item
 * assertions run against a zero-delay, possibly stale read, turning ordinary
 * replication lag into a false silent_noop. A returned row that does not
 * satisfy `accept` is treated like a miss and retried through the same
 * schedule. On exhaustion the LAST OBSERVED row is returned anyway (the
 * invoice WAS observed, so the caller adjudicates silent_noop versus
 * amount_mismatch on real data); verify_unavailable is thrown only when no
 * valid row was ever observed.
 */
export async function reReadInvoiceForVerify(
  env: Env,
  ctx: VerifyContext,
  tenant: string,
  invoiceId: number,
  opts: { tool: string; stranded: string; accept?: (inv: VerifyInvoice) => boolean },
): Promise<VerifyInvoice> {
  const delays = verifyBackoffMs(env);
  let lastReason = 'invoice not returned by the verify-read';
  let lastObserved: VerifyInvoice | undefined;

  for (let attempt = 0; ; attempt++) {
    try {
      const data = await readST<{ data?: VerifyInvoice[] }>(
        env,
        ctx,
        `/accounting/v2/tenant/${tenant}/invoices`,
        { ids: invoiceId },
      );
      const row = data.data?.[0];
      if (row && Number(row.id) === invoiceId) {
        if (!opts.accept || opts.accept(row)) return row;
        lastObserved = row;
        lastReason = `invoice ${invoiceId} observed but the expected write effect is not visible yet (read-after-write lag)`;
      } else {
        // If ST ever stops honoring `ids`, data[0] is an arbitrary invoice.
        // Verifying against it would be worse than not verifying at all.
        lastReason = row
          ? `ids filter not honored on the verify-read: asked ${invoiceId}, got ${row.id}`
          : `invoice ${invoiceId} not present in the verify-read (empty data, the normal read-after-write-lag signature)`;
      }
    } catch (err) {
      lastReason = `verify-read failed: ${(err as Error).message}`;
    }

    if (attempt >= delays.length) break;
    await sleep(delays[attempt]);
  }

  // The row was seen but never satisfied `accept`. Hand it to the caller for a
  // verdict on real observed data rather than hiding it behind verify_unavailable.
  if (lastObserved) return lastObserved;

  throw new McpError(
    'verify_unavailable',
    `${opts.tool}: the write was sent and may have taken effect, but it could NOT be verified: ${lastReason}. ` +
      `${opts.stranded} Do NOT re-run this write; check ServiceTitan first (a retry would duplicate the line or invoice).`,
    { correlation: ctx.correlation, details: { invoiceId, reason: lastReason } },
  );
}

const VERIFY_FAILURE_CODES: readonly McpErrorCode[] = ['silent_noop', 'partial_write', 'amount_mismatch', 'field_mismatch', 'verify_unavailable'];

/** True for an error raised by the verify-read checks (the write itself already happened). */
export function isVerifyFailure(err: unknown): err is McpError {
  return err instanceof McpError && VERIFY_FAILURE_CODES.includes(err.code);
}

export interface UnverifiedOutcome {
  verified: false;
  outcome: {
    remotely_verified: false;
    code: McpErrorCode;
    mismatched_fields?: string[];
    note: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Turn a verify-read failure into the result shape the write-recovery layer
 * reads: `verified: false` with `outcome.remotely_verified: false`, the failure
 * code, and the fields that disagree. A success uses `verified: true` and
 * `outcome: { remotely_verified: true }`. Returning this instead of throwing
 * keeps the specific code and the ids of what was written in the operation
 * record, where a thrown error collapses to a generic outcome-unknown.
 *
 * mismatched_fields comes from `details.field` when the check set one;
 * otherwise amount_mismatch reports ['amount'] and silent_noop and partial_write
 * report ['items']. verify_unavailable reports none: nothing was observed to disagree.
 */
export function unverifiedOutcome(err: McpError): UnverifiedOutcome {
  const details = (err.details && typeof err.details === 'object' ? { ...(err.details as Record<string, unknown>) } : {}) as Record<string, unknown>;
  // Raw transport bodies can be large and add nothing to the verdict.
  delete details.results;
  const field = typeof details.field === 'string' ? details.field : undefined;
  const fields = field ? [field]
    : err.code === 'amount_mismatch' ? ['amount']
    : err.code === 'silent_noop' || err.code === 'partial_write' ? ['items']
    : undefined;
  return {
    verified: false,
    outcome: {
      remotely_verified: false,
      code: err.code,
      ...(fields ? { mismatched_fields: fields } : {}),
      note: err.message,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    },
  };
}
