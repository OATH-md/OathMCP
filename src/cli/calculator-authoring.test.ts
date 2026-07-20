import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCalculator } from './check-calculator.js';
import { scaffoldCalculator } from './new-calculator.js';
import { promoteCalculator } from './promote-calculator.js';
import { DRAFTS_DIR, installPreflight, PromotionRollbackError, runProspectiveChecks } from './calculator-files.js';

const id = 'authoring_contract_probe';
const draft = join(DRAFTS_DIR, id);
const installProbe = join('drafts', 'install-contract-probe');

afterEach(() => {
  rmSync(draft, { recursive: true, force: true });
  rmSync(installProbe, { recursive: true, force: true });
});

describe('draft calculator authoring commands', () => {
  it('uses exit 2 for invalid usage or a missing draft', () => {
    expect(scaffoldCalculator([])).toBe(2);
    expect(checkCalculator(['--id', id])).toBe(2);
    expect(promoteCalculator(['--id', id])).toBe(2);
  });

  it('refuses overwrite and keeps incomplete candidates out of the live catalog', () => {
    expect(scaffoldCalculator(['--id', id, '--archetype', 'formula'])).toBe(0);
    expect(scaffoldCalculator(['--id', id, '--archetype', 'formula'])).toBe(1);
    expect(checkCalculator(['--id', id])).toBe(1);
    expect(promoteCalculator(['--id', id])).toBe(1);
    expect(existsSync(join('specs', `${id}.yaml`))).toBe(false);
    expect(existsSync(join('src/compute', `${id}.ts`))).toBe(false);
    expect(existsSync(join('validation/calculators', `${id}.yaml`))).toBe(false);
  });

  it('generates prospective contracts before any strict check imports the candidate', () => {
    const calls: string[] = [];
    runProspectiveChecks('/tmp/prospective', id, (_root, _command, args) => calls.push(args.join(' ')));
    expect(calls).toEqual([
      'run gen:specs',
      'run lint:specs',
      'run typecheck',
      'run build',
      `run validate:clinical -- --calculator ${id} --require-source-verified --require-scenario-verified`,
      'run test',
    ]);
  });

  it('restores existing files and removes new files when installation fails', () => {
    const existing = join(installProbe, 'existing.txt');
    const added = join(installProbe, 'added.txt');
    mkdirSync(installProbe, { recursive: true });
    writeFileSync(existing, 'before', { flag: 'w' });
    let replacements = 0;
    expect(() => installPreflight({
      temporaryRoot: '/tmp/unused',
      files: new Map([
        [existing, 'after'],
        [added, 'new'],
      ]),
    }, (source, target) => {
      replacements += 1;
      if (replacements === 2) throw new Error('injected replacement failure');
      renameSync(source, target);
    })).toThrow('injected replacement failure');
    expect(readFileSync(existing, 'utf8')).toBe('before');
    expect(existsSync(added)).toBe(false);
  });

  it('preserves recovery backups and reports an incomplete rollback', () => {
    const existing = join(installProbe, 'existing.txt');
    const added = join(installProbe, 'added.txt');
    mkdirSync(installProbe, { recursive: true });
    writeFileSync(existing, 'before');
    let replacements = 0;
    let caught: unknown;
    try {
      installPreflight({
        temporaryRoot: '/tmp/unused',
        files: new Map([
          [existing, 'after'],
          [added, 'new'],
        ]),
      }, (source, target) => {
        replacements += 1;
        if (replacements === 2) throw new Error('injected replacement failure');
        renameSync(source, target);
      }, () => {
        throw new Error('injected restore failure');
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PromotionRollbackError);
    const rollback = caught as PromotionRollbackError;
    expect(rollback.preservedBackupPaths).toHaveLength(1);
    expect(readFileSync(rollback.preservedBackupPaths[0]!, 'utf8')).toBe('before');
    expect(readFileSync(existing, 'utf8')).toBe('after');
    expect(existsSync(added)).toBe(false);
  });
});
