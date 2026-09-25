import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface GuardViolation {
  file: string;
  line: number;
  rule: string;
  text: string;
}


export const EGRESS_ALLOWLIST: Readonly<Record<string, string>> = {};

const RULES: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: 'st-host', re: /\b(?:api|auth)(?:-integration)?\.servicetitan\.io\b/ },
];

export function stripComments(source: string): string[] {
  let out = '';
  let inLineComment = false;
  let inBlockComment = false;
  let stringQuote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (inLineComment) {
      if (ch === '\n') {
        out += '\n';
        inLineComment = false;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && source[i + 1] === '/') {
        out += '  ';
        inBlockComment = false;
        i += 2;
      } else {
        out += ch === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (stringQuote) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) stringQuote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      out += '  ';
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += '  ';
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.split('\n');
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function isScannableSourceFile(name: string): boolean {
  if (!SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) return false;
  if (/\.test\.[^.]+$/.test(name)) return false;
  return true;
}

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        if (name !== '__tests__' && name !== 'node_modules') walk(abs);
        continue;
      }
      if (isScannableSourceFile(name)) out.push(abs);
    }
  };
  walk(join(root, 'src'));
  return out.sort();
}

export function scanSourceForEgress(relPath: string, source: string): GuardViolation[] {
  if (relPath.startsWith('src/backend/')) return [];
  if (Object.prototype.hasOwnProperty.call(EGRESS_ALLOWLIST, relPath)) return [];
  const rawLines = source.split('\n');
  const codeLines = stripComments(source);
  const out: GuardViolation[] = [];
  codeLines.forEach((codeLine, i) => {
    for (const { rule, re } of RULES) {
      if (!re.test(codeLine)) continue;
      out.push({ file: relPath, line: i + 1, rule, text: rawLines[i].trim().slice(0, 160) });
    }
  });
  return out;
}

export function findEgressViolations(root: string): GuardViolation[] {
  return listSourceFiles(root).flatMap((abs) =>
    scanSourceForEgress(toPosix(relative(root, abs)), readFileSync(abs, 'utf8')),
  );
}
