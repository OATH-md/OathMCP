import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bundleSpecs } from './bundle-specs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('generated compute index', () => {
  it('contains one deterministic side-effect import for every spec', () => {
    const ids = readdirSync(join(ROOT, 'specs'))
      .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
      .map((file) => file.replace(/\.ya?ml$/, ''))
      .sort();
    const generated = readFileSync(
      join(ROOT, 'src/compute/index.generated.ts'),
      'utf8',
    );
    const imports = [...generated.matchAll(/^import '\.\/(.+)\.js';$/gm)].map(
      (match) => match[1],
    );

    expect(imports).toEqual(ids);
  });

  it('keeps bundled specs, compute contracts, and review-state summaries current', async () => {
    expect(await bundleSpecs(['--check'])).toBe(0);
    const generated = readFileSync(join(ROOT, 'src/compute/types.generated.ts'), 'utf8');
    expect(generated).toContain('export type CalculatorId =');
    expect(generated).toContain('export interface CalculatorInputsById');
    expect(generated).toContain('export interface CalculatorOutputsById');
    expect(generated).toContain('"oxygenation_index"');
    expect(generated).toMatch(/"oi"\?: number/);
    const reviewStates = readFileSync(
      join(ROOT, 'src/server/validation-state.generated.ts'),
      'utf8',
    );
    expect(reviewStates).toContain('VALIDATION_REVIEW_STATES');
    expect(reviewStates).toContain('"gfr"');
    expect(reviewStates).toContain('"state": "scenario_verified"');
    expect(reviewStates).not.toContain('"state": "blocked"');
  });
});
