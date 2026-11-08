import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { scanForForbidden } from './guards/public-hygiene';

const repoRoot = process.cwd();

describe('public hygiene guard', () => {
  it('all publishable files carry no private-deployment references', () => {
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
    writeFileSync(join(root, 'LICENSE'), 'Copyright (c) 2026 Quality Service Company\n');
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

it('scans JSON, SQL, TOML, scripts and forms, and does not exempt arbitrary README text', () => {
 const root=mkdtempSync(join(tmpdir(),'public-hygiene-'));
 for(const name of ['form.json','migration.sql','worker.toml','check.py','README.md']) writeFileSync(join(root,name),'QSC internal configuration\n');
 expect(scanForForbidden(root).map(v=>v.file).sort()).toEqual(['README.md','check.py','form.json','migration.sql','worker.toml']);
});

it('rejects binary artifacts instead of silently excluding them', () => {
 const root=mkdtempSync(join(tmpdir(),'public-hygiene-'));
 writeFileSync(join(root,'generated.pyc'),Buffer.from([0,1,2,3]));
 expect(scanForForbidden(root)).toMatchObject([{file:'generated.pyc',rule:'unreviewed binary artifact'}]);
});
