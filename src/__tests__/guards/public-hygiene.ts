import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import type { GuardViolation } from './egress-scan';

// Scan every publishable file, including forms, scripts, fixtures and configuration.
// Attribution exceptions are exact lines in the three licensing documents.
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
  /\/Users\/[^/]+\//,
  /\b[a-z0-9-]+\.ts\.net\b/i,
  /qualityservicecompany\.(net|com)/i,
];

// The guard and its test hold the patterns as literals, so they cannot scan themselves.
const SELF_EXEMPT: ReadonlySet<string> = new Set([
  'src/__tests__/guards/public-hygiene.ts',
  'src/__tests__/public-hygiene.test.ts',
]);

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    if (['.git','node_modules','.wrangler','.venv','__pycache__','.pytest_cache'].includes(name)) return [];
    const abs=join(dir,name);
    return statSync(abs).isDirectory() ? listFiles(abs) : [abs];
  });
}
const ATTRIBUTION_LINES = new Set(["LICENSE:Copyright (c) 2026 Quality Service Company", "NOTICE:Copyright (c) 2026 Quality Service Company", "NOTICE:Quality Service Company holds the copyright in this software and nothing more. The software is provided \"as is\", without warranty of any kind. Quality Service Company accepts no liability for any use, deployment, fork, or derivative of this software, and publishing it is not an endorsement.", "README.md:Copyright \u00a9 2026 Quality Service Company. Released under the MIT License (see `LICENSE`). Maintained by Luke Peluso.", "README.md:Quality Service Company holds the copyright in this software and nothing more. It provides the software \"as is\", without warranty of any kind, and accepts no liability for any use of it, any deployment of it, or any fork or derivative of it. Publishing this software is not an endorsement, and Quality Service Company does not support, warrant, or vouch for this project or anything built with it. Please direct questions and issues to this repository, not to Quality Service Company."]);
export function scanForForbidden(root: string): GuardViolation[] {
  let files: string[];
  try {
    // A standalone fixture directory must not inherit the parent repository list.
    const top=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    if(top!==root) throw new Error('not repository root');
    files=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).map(p=>join(root,p)).filter(existsSync);
  } catch { files=listFiles(root); }
  const out: GuardViolation[] = [];
  for (const abs of files.sort()) {
    const rel = toPosix(relative(root, abs));
    if (SELF_EXEMPT.has(rel)) continue;
    if (readFileSync(abs).includes(0)) {
      out.push({ file: rel, line: 1, rule: 'unreviewed binary artifact', text: 'Public distribution must contain reviewable source files' });
      continue;
    }
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const re of FORBIDDEN_PUBLIC_PATTERNS) {
          if (ATTRIBUTION_LINES.has(`${rel}:${line}`) && README_EXEMPT_PATTERNS.includes(re)) continue;
          if (!re.test(line)) continue;
          out.push({ file: rel, line: i + 1, rule: re.source, text: line.trim().slice(0, 160) });
        }
      });
  }
  return out;
}
