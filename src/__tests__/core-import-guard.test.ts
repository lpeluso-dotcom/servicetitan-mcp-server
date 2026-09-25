import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findCoreImportViolations, coreEntryFiles, resolveRelative, stripQuerySuffix } from './guards/core-imports';
import { RESOURCE_MODULE_TIERS } from '../tiers';

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

describe('core-import guard', () => {
  it('no core item reaches an internal-only module or a disallowed host', () => {
    const root = process.cwd();
    const entries = coreEntryFiles(root, RESOURCE_MODULE_TIERS);
    expect(entries).toContain('src/tools/public-registry.ts');
    const violations = findCoreImportViolations(root, entries);
    expect(violations.map((v) => `${v.rule} ${v.file} via ${v.text}`)).toEqual([]);
  });

  it('flags direct and transitive violations with the import chain (fixture)', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
    write(root, 'src/tools/public-registry.ts', "import { a } from './a';\nexport const PUBLIC_TOOLS = [a];\n");
    write(root, 'src/tools/a.ts', "import type { T } from '../types-only';\nimport { helper } from '../helper';\nexport const a = helper;\n");
    write(root, 'src/types-only.ts', 'export type T = number;\n');
    write(root, 'src/helper.ts', "import { readD1 } from './forbidden-b';\nimport './ui';\nexport const helper = readD1;\n");
    write(root, 'src/forbidden-b.ts', 'export const readD1 = 1;\n');
    write(root, 'src/ui.ts', "// go.servicetitan.com in a comment is fine\nexport const U = 'https://go.servicetitan.com/app/api/x';\n");
    write(root, 'src/tools/index.ts', "import { x } from '../forbidden-a';\nexport const TOOLS = [x];\n");
    write(root, 'src/forbidden-a.ts', 'export const x = 1;\n');

    const violations = findCoreImportViolations(root, ['src/tools/public-registry.ts']);
    expect(violations.map((v) => `${v.rule} ${v.file}:${v.line}`).sort()).toEqual([
      'forbidden-module src/forbidden-b.ts:0',
      'ui-api src/ui.ts:2',
    ]);
    expect(violations.find((v) => v.rule === 'forbidden-module')!.text).toBe(
      'src/tools/public-registry.ts -> src/tools/a.ts -> src/helper.ts -> src/forbidden-b.ts',
    );
  });

  it('follows the registry edge when it is not skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
    write(root, 'src/entry.ts', "import { TOOLS } from './tools/index';\nexport const E = TOOLS;\n");
    write(root, 'src/tools/index.ts', "import { x } from '../forbidden-a';\nexport const TOOLS = [x];\n");
    write(root, 'src/forbidden-a.ts', 'export const x = 1;\n');
    expect(findCoreImportViolations(root, ['src/entry.ts'])).toEqual([]);
    expect(findCoreImportViolations(root, ['src/entry.ts'], []).map((v) => v.file)).toEqual(['src/forbidden-a.ts']);
  });

  it('flags a disallowed-host line that only looks like a comment when read alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
    write(root, 'src/tools/public-registry.ts', "import { U1, U2 } from '../leaky';\nexport const PUBLIC_TOOLS = [U1, U2];\n");
    write(
      root,
      'src/leaky.ts',
      [
        "/* eslint-disable */ export const U1 = 'https://go.servicetitan.com/app/api/x';",
        '/*',
        ' * block comment',
        " */ export const U2 = 'https://go.servicetitan.com/app/api/y';",
      ].join('\n') + '\n',
    );

    const violations = findCoreImportViolations(root, ['src/tools/public-registry.ts']);
    expect(violations.map((v) => `${v.rule} ${v.file}:${v.line}`)).toEqual([
      'ui-api src/leaky.ts:1',
      'ui-api src/leaky.ts:4',
    ]);
  });

  it('flags a forbidden module reached only via require()', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
    write(root, 'src/tools/public-registry.ts', "import { R } from '../requirer';\nexport const PUBLIC_TOOLS = [R];\n");
    write(root, 'src/requirer.ts', "const { readD1 } = require('./forbidden-b');\nexport const R = readD1;\n");
    write(root, 'src/forbidden-b.ts', 'export const readD1 = 1;\n');

    const violations = findCoreImportViolations(root, ['src/tools/public-registry.ts']);
    expect(violations.map((v) => `${v.rule} ${v.file}:${v.line}`)).toEqual(['forbidden-module src/forbidden-b.ts:0']);
  });

  it('resolves a .js specifier to the matching .ts source file (TS ESM convention)', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
    write(root, 'src/tools/public-registry.ts', "import { R } from '../jsimporter';\nexport const PUBLIC_TOOLS = [R];\n");
    write(root, 'src/jsimporter.ts', "import { readD1 } from './forbidden-b.js';\nexport const R = readD1;\n");
    write(root, 'src/forbidden-b.ts', 'export const readD1 = 1;\n');

    const violations = findCoreImportViolations(root, ['src/tools/public-registry.ts']);
    expect(violations.map((v) => `${v.rule} ${v.file}:${v.line}`)).toEqual(['forbidden-module src/forbidden-b.ts:0']);
  });

  it('does not walk a commented-out forbidden import', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
    write(root, 'src/tools/public-registry.ts', "import { C } from '../clean';\nexport const PUBLIC_TOOLS = [C];\n");
    write(root, 'src/clean.ts', "// import { x } from './forbidden-a';\nexport const C = 1;\n");
    write(root, 'src/forbidden-a.ts', 'export const x = 1;\n');

    expect(findCoreImportViolations(root, ['src/tools/public-registry.ts'])).toEqual([]);
  });

  it('strips a trailing ?query before resolving a relative specifier', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
    write(root, 'src/a.ts', 'export const A = 1;\n');
    const fromAbs = join(root, 'src/index.ts');

    expect(resolveRelative(fromAbs, './a.ts?raw')).toBe(join(root, 'src/a.ts'));
    expect(stripQuerySuffix('./a.ts?raw&x=1')).toBe('./a.ts');
    expect(stripQuerySuffix('./a.ts')).toBe('./a.ts');
  });

  it('walks a ?raw-suffixed import the same as a normal one, forbidden module included', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-guard-'));
    write(root, 'src/tools/public-registry.ts', "import raw from '../leaky.ts?raw';\nexport const PUBLIC_TOOLS = [raw];\n");
    write(root, 'src/leaky.ts', "import { readD1 } from './forbidden-b';\nexport default readD1;\n");
    write(root, 'src/forbidden-b.ts', 'export const readD1 = 1;\n');

    const violations = findCoreImportViolations(root, ['src/tools/public-registry.ts']);
    expect(violations.map((v) => `${v.rule} ${v.file}:${v.line}`)).toEqual(['forbidden-module src/forbidden-b.ts:0']);
  });
});
