// ============================================================
// pricebook-payload: user-to-ServiceTitan field-name transform for pricebook writes
//
// ServiceTitan silently drops these pricebook fields on POST and PATCH:
//   - `name` is ignored; only `displayName` updates the customer-facing label
//   - `categoryId` (singular) is ignored; ST expects `categories: [<int>]`
//   - `useStaticPrice` (singular) is ignored; ST expects plural `useStaticPrices`
//
// The tools keep the user-facing arg names (`name`, `categoryId`) for ergonomics,
// but the outbound payload is rewritten at the boundary so ST actually persists
// the change. Without the rewrite, services land with displayName:null and
// categories:[].
// ============================================================
import { readST } from '../st';
import type { WriteVerifyInput, WriteVerifyResult } from '../write-tool-factory';

export function toStPricebookPayload<T extends Record<string, unknown>>(
  payload: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  if ('name' in out) {
    out.displayName = out.name;
    delete out.name;
  }
  // Multi-cat: prefer `categories[]` if both passed.
  if ('categories' in out && Array.isArray(out.categories)) {
    delete out.categoryId;
  } else if ('categoryId' in out) {
    out.categories = [out.categoryId];
    delete out.categoryId;
  }
  // Belt-and-suspenders: singular useStaticPrice is silently dropped by ST.
  // The zod schema does not accept it; this guards against bypasses.
  if ('useStaticPrice' in out) {
    delete out.useStaticPrice;
  }
  return out;
}

// ------------------------------------------------------------
// Read-back verification. ServiceTitan can answer 200 to a pricebook write and
// still drop fields, so after a write the resource is read again and every field
// that was sent is compared with what is stored. A field the read-back does not
// show counts as dropped.
// ------------------------------------------------------------
function idOf(v: unknown): unknown {
  return v !== null && typeof v === 'object' && 'id' in v ? (v as { id: unknown }).id : v;
}

function sameValue(sent: unknown, got: unknown): boolean {
  if (Array.isArray(sent)) {
    if (!Array.isArray(got)) return false;
    const a = sent.map((x) => String(idOf(x))).sort();
    const b = got.map((x) => String(idOf(x))).sort();
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (typeof sent === 'number') {
    const n = typeof got === 'string' && got.trim() !== '' ? Number(got) : got;
    return typeof n === 'number' && Math.abs(n - sent) < 1e-6;
  }
  return sent === got;
}

// Returns the names of sent fields whose stored value differs. Nested objects
// (a material's primaryVendor) are compared key by key as `parent.key`.
function mismatches(sent: Record<string, unknown>, stored: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(sent)) {
    if (value === undefined) continue;
    const got = stored[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = got !== null && typeof got === 'object' && !Array.isArray(got) ? (got as Record<string, unknown>) : {};
      out.push(...mismatches(value as Record<string, unknown>, nested, `${prefix}${key}.`));
    } else if (!sameValue(value, got)) {
      out.push(`${prefix}${key}`);
    }
  }
  return out;
}

export function verifyPricebookWrite(kind: 'services' | 'materials') {
  return async ({ env, args, payload, result, actor, correlation }: WriteVerifyInput<unknown>): Promise<WriteVerifyResult> => {
    // PATCH carries the id in its args; POST gets it from the write response.
    const envelope = result as { id?: unknown; response?: { id?: unknown } } | null;
    const id = (args as { id?: unknown } | null)?.id ?? envelope?.response?.id ?? envelope?.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      return { verified: false, note: 'write response carried no id to read back' };
    }
    const stored = await readST<Record<string, unknown>>(
      env, { actor, correlation }, `/pricebook/v2/tenant/000000000/${kind}/${encodeURIComponent(String(id))}`,
    );
    const mismatchedFields = mismatches(payload as Record<string, unknown>, stored ?? {});
    return mismatchedFields.length === 0 ? { verified: true } : { verified: false, mismatchedFields };
  };
}
