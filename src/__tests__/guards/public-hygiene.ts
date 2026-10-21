import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { GuardViolation } from './egress-scan';

// This repo is public. Nothing in src/, docs/, CHANGELOG.md or README.md may
// name the private deployment it was derived from: ticket refs, company or host
// names, people, the private repo, tenant report IDs, or the private data stores.
//
// The company-name patterns (README_EXEMPT_PATTERNS) apply everywhere except the
// README, which names the copyright holder on purpose in its ownership section.
export const README_EXEMPT_PATTERNS: readonly RegExp[] = [
  /quality\s*service/i,
  /qualityservice/i,
  /\bqsc\b/i,
];

export const FORBIDDEN_PUBLIC_PATTERNS: readonly RegExp[] = [
  /\bQUA-\d+/i,
  /\bBSO-\d+/i,
  /\bMB-\d+/i,
  ...README_EXEMPT_PATTERNS,
  /\bdev0\d\b/i,
  /lpeluso/i,
  /taylor-ai/i,
  /supabase/i,
  /\bd1-proxy\b/i,
  /mirror-freshness/i,
  /mcp-servicetitan\b/i,
  /~\/work\//,
];

// The guard and its test hold the patterns as literals, so they cannot scan themselves.
const SELF_EXEMPT: ReadonlySet<string> = new Set([
  'src/__tests__/guards/public-hygiene.ts',
  'src/__tests__/public-hygiene.test.ts',
]);

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, ext));
    else if (name.endsWith(ext)) out.push(abs);
  }
  return out;
}

export function scanForForbidden(root: string): GuardViolation[] {
  const files = [...listFiles(join(root, 'src'), '.ts'), ...listFiles(join(root, 'docs'), '.md')];
  for (const top of ['README.md', 'CHANGELOG.md']) {
    const abs = join(root, top);
    if (existsSync(abs)) files.push(abs);
  }

  const out: GuardViolation[] = [];
  for (const abs of files.sort()) {
    const rel = toPosix(relative(root, abs));
    if (SELF_EXEMPT.has(rel)) continue;
    const isReadme = rel === 'README.md';
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const re of FORBIDDEN_PUBLIC_PATTERNS) {
          if (isReadme && README_EXEMPT_PATTERNS.includes(re)) continue;
          if (!re.test(line)) continue;
          out.push({ file: rel, line: i + 1, rule: re.source, text: line.trim().slice(0, 160) });
        }
      });
  }
  return out;
}
