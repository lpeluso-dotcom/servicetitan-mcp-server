// Path normalisation shared by the contract check. Spec rule (2026-10-21 design, Part 1):
// strip the server prefix, {tid}/{tenant} → {tenant}, every other {param} → {}, exact match.

export function normalizeStPath(path: string): string {
  let p = path.trim();
  // Regex, not new URL().pathname: URL percent-encodes { and }, which would hide the params.
  p = p.replace(/^https?:\/\/[^/?#]+/i, '').replace(/[?#].*$/, '');
  p = p
    .replace(/\/tenant\/000000000(?=\/|$)/g, '/tenant/{tenant}') // literal placeholder tenant id
    .replace(/\{(tid|tenant)\}/g, '{tenant}').replace(/\{(?!tenant\})[^}]*\}/g, '{}');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function opKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizeStPath(path)}`;
}
