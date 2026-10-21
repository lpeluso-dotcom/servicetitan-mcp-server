// ============================================================
// sku-resolve.ts: resolve a pricebook SKU name against the LIVE ServiceTitan
// pricebook before a write that resolves invoice lines by name.
//
// WHY (an asymmetry, not paranoia): on the invoice-items PATCH endpoint an
// unresolvable SKU fails loudly (HTTP 500 "Sku (Name:) is not found."), so
// presence-validation is enough there. On POST /invoices (adjustment create)
// the failure mode is the opposite: a bad `skuName` is indistinguishable from
// a missing one, the line is dropped, and ServiceTitan answers HTTP 200 with a
// ZERO-ITEM $0.00 adjustment invoice. Adjustment invoices cannot be deleted
// through the API, so the name has to be checked BEFORE the write.
//
// HOW: ServiceTitan's pricebook list endpoints have no exact-code filter that
// this server relies on (the code search tools scan the catalogue and match
// client-side), so this reuses `scanCatalog` and `matchesCode` from the
// pricebook catalogue helpers. All three catalogues (services, materials,
// equipment) are scanned, because a code can exist in more than one and the
// answer must not depend on scan order. Each catalogue is scanned at most once
// per call, however many names are checked.
//
// MATCHING is by pricebook CODE only. A display name is not a SKU name here:
// nothing shows ServiceTitan resolves an adjustment line by display name, so a
// name-only input is `not_found`. Levels, across all three catalogues:
//   1. an exact, case-sensitive code match wins;
//   2. otherwise a variant match (case-insensitive, hyphen variants);
//   3. more than one row at the winning level is `ambiguous`, never a guess.
// `matched` is the row's exact code: that is the string the caller must put on
// the wire, so what was checked is what gets sent.
//
// FAIL CLOSED. The only evidence here is the live read. If a catalogue read
// failed, or a scan hit its page cap before finding the name, the answer is
// `unavailable`, never `not_found` and never `resolved`. The caller must treat
// `unavailable` as a block: a silent $0 invoice cannot be deleted, so "could not
// check" is not good enough to write. A unique EXACT hit inside a capped or
// partly failed scan is still a hit. A unique VARIANT hit is not: an exact code
// in the unseen rows would outrank it, so that case is `unavailable` too.
// Ambiguity is judged on the rows that were seen.
// ============================================================

import type { Env } from '../../env';
import type { ReadSTContext } from '../../st';
import { scanCatalog, matchesCode, type CatalogKind, type CatalogScan, type CatalogRow } from '../pricebook/catalog-scan';

export type SkuResolution =
  | { status: 'resolved'; skuName: string; matched: string; kind: CatalogKind; active?: boolean }
  | { status: 'ambiguous'; skuName: string; candidates: string[] }
  | { status: 'not_found'; skuName: string }
  | { status: 'unavailable'; skuName: string; reason: string };

const KINDS: readonly CatalogKind[] = ['service', 'material', 'equipment'];
const PLURAL: Record<CatalogKind, string> = { service: 'services', material: 'materials', equipment: 'equipment' };

type ScanOutcome = { ok: true; scan: CatalogScan } | { ok: false; reason: string };
interface Match { kind: CatalogKind; row: CatalogRow & { code: string } }

const describe = (m: Match): string => `${m.kind} ${m.row.code} (id ${m.row.id})`;

/**
 * Resolve several SKU names with one lazy scan per catalogue. Results come back
 * in input order, one per name (repeats included).
 */
export async function resolveSkus(env: Env, ctx: ReadSTContext, skuNames: readonly string[]): Promise<SkuResolution[]> {
  const scans = new Map<CatalogKind, Promise<ScanOutcome>>();
  const scanOnce = (kind: CatalogKind): Promise<ScanOutcome> => {
    let pending = scans.get(kind);
    if (!pending) {
      pending = scanCatalog(env, ctx, kind).then(
        (scan): ScanOutcome => ({ ok: true, scan }),
        (err): ScanOutcome => ({ ok: false, reason: `${PLURAL[kind]} catalogue read failed: ${(err as Error).message}` }),
      );
      scans.set(kind, pending);
    }
    return pending;
  };

  const out: SkuResolution[] = [];
  for (const skuName of skuNames) {
    const wanted = skuName.trim();
    if (wanted === '') {
      out.push({ status: 'not_found', skuName });
      continue;
    }
    const gaps: string[] = [];
    const exact: Match[] = [];
    const variant: Match[] = [];
    for (const kind of KINDS) {
      const outcome = await scanOnce(kind);
      if (!outcome.ok) {
        gaps.push(outcome.reason);
        continue;
      }
      for (const row of outcome.scan.rows) {
        if (typeof row.code !== 'string') continue;
        const m = { kind, row: row as Match['row'] };
        if (row.code === wanted) exact.push(m);
        else if (matchesCode(row, wanted)) variant.push(m);
      }
      if (outcome.scan.truncated) {
        gaps.push(`${PLURAL[kind]} scan truncated at ${outcome.scan.pagesFetched} pages; rows beyond that were not searched`);
      }
    }
    const winners = exact.length > 0 ? exact : variant;
    if (exact.length === 0 && winners.length === 1 && gaps.length > 0) {
      // A lone variant is only the answer when no exact code exists anywhere.
      // An unread or capped catalogue could hold that exact code, so say so.
      out.push({ status: 'unavailable', skuName, reason: gaps.join('; ') });
    } else if (winners.length === 1) {
      const [w] = winners;
      out.push({
        status: 'resolved', skuName, matched: w.row.code, kind: w.kind,
        ...(typeof w.row.active === 'boolean' ? { active: w.row.active } : {}),
      });
    } else if (winners.length > 1) {
      out.push({ status: 'ambiguous', skuName, candidates: winners.map(describe) });
    } else if (gaps.length > 0) {
      out.push({ status: 'unavailable', skuName, reason: gaps.join('; ') });
    } else {
      out.push({ status: 'not_found', skuName });
    }
  }
  return out;
}

export async function resolveSku(env: Env, ctx: ReadSTContext, skuName: string): Promise<SkuResolution> {
  return (await resolveSkus(env, ctx, [skuName]))[0];
}
