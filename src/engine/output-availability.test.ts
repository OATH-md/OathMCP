import { describe, expect, it } from 'vitest';
import type { OutputSpec } from './spec-schema.js';
import {
  assertOutputConditionCoverage,
  outputShouldBePresent,
  registerOutputCondition,
} from './output-availability.js';
import { validateOutputValue } from './run.js';

const common = {
  title: 'Output', description: 'Output.', availability: { kind: 'always' as const },
  evidenceRefs: ['source_1'],
};

describe('output availability and values', () => {
  it('uses normalized input presence for conditional outputs', () => {
    expect(outputShouldBePresent('oxygenation_index', 'oi', {
      inputs: { mean_airway_pressure: 10, fio2: 50, pao2: 80 }, outputs: {},
    })).toBe(true);
    expect(outputShouldBePresent('oxygenation_index', 'osi', {
      inputs: { mean_airway_pressure: 10, fio2: 50, pao2: 80 }, outputs: {},
    })).toBe(false);
  });

  it('rejects duplicate registrations and unregistered declarations', () => {
    expect(() => registerOutputCondition('neonatal_measurements', 'gestational_age_ett_supported', () => true)).toThrow(/already registered/);
    expect(() => assertOutputConditionCoverage([{
      id: 'bmi', outputs: { bmi: { availability: { kind: 'computeCondition', conditionId: 'missing' } } },
    }])).toThrow(/missing is not registered/);
  });

  it('validates finite lists and ordered range objects exactly', () => {
    const list = { ...common, kind: 'number_list' as const } satisfies OutputSpec;
    const range = { ...common, kind: 'number_range' as const } satisfies OutputSpec;
    expect(validateOutputValue([1, 2], list)).toBe(true);
    expect(validateOutputValue([1, Number.NaN], list)).toBe(false);
    expect(validateOutputValue({ low: 1, high: 3, mean: 2 }, range)).toBe(true);
    expect(validateOutputValue({ low: 3, high: 1 }, range)).toBe(false);
    expect(validateOutputValue({ low: 1, high: 3, mean: 4 }, range)).toBe(false);
    expect(validateOutputValue({ low: 1, high: 3, extra: 2 }, range)).toBe(false);
  });
});
