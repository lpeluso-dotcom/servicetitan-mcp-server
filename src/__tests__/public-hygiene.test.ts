import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { scanForForbidden } from './guards/public-hygiene';

const repoRoot = process.cwd();

describe('public hygiene guard', () => {
  it('src, docs, CHANGELOG and README carry no private-deployment references', () => {
    const violations = scanForForbidden(repoRoot);
    expect(violations.map((v) => `${v.file}:${v.line} ${v.rule}`)).toEqual([]);
  });

  it('flags a planted string', () => {
    const root = mkdtempSync(join(tmpdir(), 'public-hygiene-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'planted.ts'), '// see QUA-1\nexport const ok = 1;\n');
    writeFileSync(join(root, 'README.md'), '# clean readme\n');
    const violations = scanForForbidden(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('src/planted.ts');
    expect(violations[0].line).toBe(1);
  });

  it('allows the company name in the README', () => {
    const root = mkdtempSync(join(tmpdir(), 'public-hygiene-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'Copyright 2026 Quality Service Company.\n');
    expect(scanForForbidden(root)).toEqual([]);
  });

  it('still flags a ticket ref in the README', () => {
    const root = mkdtempSync(join(tmpdir(), 'public-hygiene-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'Tracked in QUA-1.\n');
    const violations = scanForForbidden(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('README.md');
  });

  it('flags the company name in a src file', () => {
    const root = mkdtempSync(join(tmpdir(), 'public-hygiene-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'planted.ts'), '// built by Quality Service\nexport const ok = 1;\n');
    const violations = scanForForbidden(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('src/planted.ts');
  });

  it('flags the company name in docs and CHANGELOG (README is the only exception)', () => {
    const root = mkdtempSync(join(tmpdir(), 'public-hygiene-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'planted.md'), 'Built for QSC.\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '## 0.2.0\n- Fix from Quality Service.\n');
    const files = scanForForbidden(root).map((v) => v.file).sort();
    expect(files).toEqual(['CHANGELOG.md', 'docs/planted.md']);
  });

  it('flags the private repo name and home-directory path', () => {
    const root = mkdtempSync(join(tmpdir(), 'public-hygiene-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'planted.md'), 'see mcp-servicetitan\nclone to ~/work/x\n');
    expect(scanForForbidden(root).map((v) => v.line).sort()).toEqual([1, 2]);
  });
});
