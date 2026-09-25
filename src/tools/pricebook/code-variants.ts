export function codeVariants(raw: string): string[] {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  const hyphenated = upper.replace(/^([A-Z]+)(\d.*)$/, '$1-$2');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [trimmed, upper, hyphenated]) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
