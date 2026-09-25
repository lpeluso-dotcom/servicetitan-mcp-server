import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { stripComments, type GuardViolation } from './egress-scan';

export const FORBIDDEN_MODULES: readonly string[] = [
  'forbidden-a', 'forbidden-b', 'forbidden-c', 'forbidden-d', 'forbidden-e', 'forbidden-f',
  'forbidden-g', 'forbidden-h', 'forbidden-i', 'forbidden-j',
];


export const REGISTRY_FILE = 'src/tools/index.ts';

const UI_API = /\/app\/api\/|\bgo\.servicetitan\.com\b/;
const SPEC_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"`]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function importSpecifiers(source: string): string[] {
  const stripped = stripComments(source).join('\n');
  const out: string[] = [];
  for (const m of stripped.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) out.push(spec);
  }
  return out;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];


const JS_TO_TS_EXTENSION: Readonly<Record<string, string>> = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };


export function stripKnownExtension(name: string): string {
  for (const ext of RESOLVE_EXTENSIONS) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

const QUERY_SUFFIX_RE = /\?.*$/;

export function stripQuerySuffix(spec: string): string {
  return spec.replace(QUERY_SUFFIX_RE, '');
}

export function resolveRelative(fromAbs: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const specPath = stripQuerySuffix(spec);
  const base = resolve(dirname(fromAbs), specPath);
  const candidates = [base];
  for (const [jsExt, tsExt] of Object.entries(JS_TO_TS_EXTENSION)) {
    if (specPath.endsWith(jsExt)) candidates.push(base.slice(0, -jsExt.length) + tsExt);
  }
  candidates.push(
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...RESOLVE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export interface ClosureResult {
  files: string[];
  parent: Map<string, string | null>;
}

export function importClosure(
  root: string,
  entries: readonly string[],
  skip: readonly string[] = [REGISTRY_FILE],
): ClosureResult {
  const skipAbs = new Set(skip.map((s) => resolve(root, s)));
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const entry of entries) {
    const abs = resolve(root, entry);
    if (!parent.has(abs)) {
      parent.set(abs, null);
      queue.push(abs);
    }
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      const dep = resolveRelative(file, spec);
      if (!dep || skipAbs.has(dep) || parent.has(dep)) continue;
      parent.set(dep, file);
      queue.push(dep);
    }
  }
  return { files: [...parent.keys()], parent };
}

function chain(root: string, parent: Map<string, string | null>, file: string): string {
  const parts: string[] = [];
  let cur: string | null = file;
  while (cur) {
    parts.unshift(toPosix(relative(root, cur)));
    cur = parent.get(cur) ?? null;
  }
  return parts.join(' -> ');
}

export function findCoreImportViolations(
  root: string,
  entries: readonly string[],
  skip: readonly string[] = [REGISTRY_FILE],
): GuardViolation[] {
  const { files, parent } = importClosure(root, entries, skip);
  const out: GuardViolation[] = [];
  for (const abs of files) {
    const file = toPosix(relative(root, abs));
    const via = chain(root, parent, abs);
    if (FORBIDDEN_MODULES.includes(stripKnownExtension(basename(abs)))) {
      out.push({ file, line: 0, rule: 'forbidden-module', text: via });
    }

    stripComments(readFileSync(abs, 'utf8')).forEach((line, i) => {
      if (UI_API.test(line)) out.push({ file, line: i + 1, rule: 'ui-api', text: via });
    });
  }
  return out;
}

export function coreEntryFiles(
  root: string,
  resourceTiers: Readonly<Record<string, 'core' | 'internal'>>,
): string[] {
  const entries = [
    'src/tools/public-registry.ts',
    ...Object.entries(resourceTiers).filter(([, tier]) => tier === 'core').map(([file]) => file),
    'src/public-entry.ts',
  ];
  return entries.filter((e) => existsSync(join(root, e)));
}
