import { describe, expect, it } from 'vitest';
import { executeValidationCases } from './case-runner.js';
import { ValidationDossierSchema, type ValidationCaseRunner } from './schema.js';

function dossier(testCase: Record<string, unknown>) {
  return ValidationDossierSchema.parse({
    calculatorId: 'bmi', specVersion: '1.0.0', clinicalModel: 'BMI', variant: 'adult',
    population: 'adult', setting: 'test', assessmentTiming: 'current', endpoint: 'value',
    reviewGroup: 'formula_unit_dosing', enrollment: 'pending_independent_review', searchRecords: [],
    authoritySourceIds: [], explicitBlockers: [],
    claims: [{
      id: 'claim:one', kind: 'formula', statement: 'test claim', covers: ['formula:implementation'],
      status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'test' }],
      executable: true, scenarioIds: ['case:one'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
    }],
    cases: [{
      kind: 'reference', id: 'case:one', tags: ['required-inputs'], inputs: {},
      tolerance: { mode: 'exact', rationale: 'exact test' }, claimIds: ['claim:one'], sourceIds: ['source:one'],
      witnesses: ['formula:implementation'],
      ...testCase,
    }],
  });
}

function runner(
  engine: () => unknown,
  full: () => unknown = engine,
  compact: () => unknown = engine,
): ValidationCaseRunner {
  return {
    runEngine: async () => engine(),
    runFullMcp: async () => full(),
    runCompactMcp: async () => compact(),
  };
}

describe('validation case execution', () => {
  it('does not pass warn behavior without the expected warning', async () => {
    const test = dossier({ expected: { value: 1 }, expectedBehavior: 'warn', expectedWarnings: ['unusual'] });
    const results = await executeValidationCases(
      test,
      runner(() => ({ results: [{ name: 'value', value: 1 }], warnings: [] })),
    );
    expect(results.get('case:one')?.status).toBe('failed');
    const drifted = await executeValidationCases(
      test,
      runner(() => ({ results: [{ name: 'value', value: 1 }], warnings: ['unusual plus unsupported drift'] })),
    );
    expect(drifted.get('case:one')?.status).toBe('failed');
    const extra = await executeValidationCases(
      test,
      runner(() => ({ results: [{ name: 'value', value: 1 }], warnings: ['unusual', 'undeclared'] })),
    );
    expect(extra.get('case:one')?.status).toBe('failed');
  });

  it('does not pass calculate behavior with an undeclared warning', async () => {
    const test = dossier({ expected: { value: 1 }, expectedBehavior: 'calculate' });
    const results = await executeValidationCases(
      test,
      runner(() => ({ results: [{ name: 'value', value: 1 }], warnings: ['undeclared'] })),
    );
    expect(results.get('case:one')?.status).toBe('failed');
  });

  it('matches reject behavior to the exact error discriminant', async () => {
    const test = dossier({
      expected: {}, expectedBehavior: 'reject',
      expectedError: { code: 'BAD_TYPE', field: 'value', messageIncludes: 'wrong type' },
    });
    const unrelated = await executeValidationCases(test, runner(() => { throw new Error('transport crash'); }));
    expect(unrelated.get('case:one')?.status).toBe('failed');
    const matched = await executeValidationCases(test, runner(() => {
      throw Object.assign(new Error('wrong type'), { code: 'BAD_TYPE', field: 'value' });
    }));
    expect(matched.get('case:one')?.status).toBe('passed');
    const drifted = await executeValidationCases(test, runner(() => {
      throw Object.assign(new Error('wrong type plus unsupported drift'), { code: 'BAD_TYPE', field: 'value' });
    }));
    expect(drifted.get('case:one')?.status).toBe('failed');
  });

  it('uses true relative tolerance below one', async () => {
    const results = await executeValidationCases(
      dossier({ expected: { value: 0.1 }, expectedBehavior: 'calculate', tolerance: { mode: 'relative', value: 0.1, rationale: 'ten percent' } }),
      runner(() => ({ results: [{ name: 'value', value: 1 }], warnings: [] })),
    );
    expect(results.get('case:one')?.status).toBe('failed');
  });

  it('applies numeric tolerance recursively to composite outputs', async () => {
    const test = dossier({
      expected: { value: { low: 35, mean: 50, high: 66 }, labels: ['day_one', 'reference'] },
      expectedBehavior: 'calculate',
      tolerance: { mode: 'absolute', value: 0.01, rationale: 'published table precision' },
    });
    const passed = await executeValidationCases(test, runner(() => ({
      results: [
        { name: 'value', value: { low: 35, mean: 50.005, high: 66 } },
        { name: 'labels', value: ['day_one', 'reference'] },
      ],
      warnings: [],
    })));
    expect(passed.get('case:one')?.status).toBe('passed');

    const failed = await executeValidationCases(test, runner(() => ({
      results: [
        { name: 'value', value: { low: 35, mean: 50.02, high: 66 } },
        { name: 'labels', value: ['day_one', 'reference'] },
      ],
      warnings: [],
    })));
    expect(failed.get('case:one')?.status).toBe('failed');
  });

  it('bounds case concurrency while preserving dossier order', async () => {
    const template = dossier({ expected: { value: 1 }, expectedBehavior: 'calculate' });
    const cases = Array.from({ length: 12 }, (_, index) => ({
      ...template.cases[0],
      id: `case:${index}`,
    }));
    let active = 0;
    let maximumActive = 0;
    const boundedRunner = runner(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { results: [{ name: 'value', value: 1 }], warnings: [] };
    });

    const results = await executeValidationCases({ ...template, cases }, boundedRunner);

    expect(maximumActive).toBeLessThanOrEqual(24);
    expect([...results.keys()]).toEqual(cases.map((entry) => entry.id));
  });

  it('proves omission on a successful result', async () => {
    const results = await executeValidationCases(
      dossier({ expected: { value: 1 }, expectedBehavior: 'omit', omittedOutputs: ['conditional'] }),
      runner(() => ({ results: [{ name: 'value', value: 1 }], warnings: [] })),
    );
    expect(results.get('case:one')?.status).toBe('passed');
  });

  it('matches source-derived interpretation expectations instead of discarding them', async () => {
    const test = dossier({
      expected: { value: 1 }, expectedBehavior: 'calculate',
      expectedInterpretations: [{ output: 'value', code: 'high', kind: 'class', label: 'High', severity: 'warning' }],
    });
    const failed = await executeValidationCases(test, runner(() => ({
      results: [{ name: 'value', value: 1 }], interpretations: [{ output: 'value', code: 'low', kind: 'class', label: 'Low', severity: 'info' }], warnings: [],
    })));
    expect(failed.get('case:one')?.status).toBe('failed');
    const passed = await executeValidationCases(test, runner(() => ({
      results: [{ name: 'value', value: 1 }], interpretations: [{ output: 'value', code: 'high', kind: 'class', label: 'High', severity: 'warning' }], warnings: [],
    })));
    expect(passed.get('case:one')?.status).toBe('passed');
  });

  it('requires exact engine, full MCP, and compact MCP payload parity beyond tolerance matching', async () => {
    const test = dossier({
      expected: { value: 1 }, expectedBehavior: 'calculate',
      tolerance: { mode: 'absolute', value: 0.01, rationale: 'published precision' },
    });
    const result = (value: number, warnings: string[] = []) => ({
      results: [{ name: 'value', value }], warnings, interpretations: [],
    });
    const numericDrift = await executeValidationCases(test, runner(
      () => result(1),
      () => result(1.005),
      () => result(1),
    ));
    expect(numericDrift.get('case:one')).toMatchObject({
      status: 'failed', enginePassed: true, fullMcpPassed: true, compactMcpPassed: true, parityPassed: false,
    });
    expect(numericDrift.get('case:one')?.issues.map((entry) => entry.code)).toContain('case.surface_parity');

    const extraWarning = await executeValidationCases(test, runner(
      () => result(1),
      () => result(1),
      () => result(1, ['compact-only warning']),
    ));
    expect(extraWarning.get('case:one')?.parityPassed).toBe(false);
  });

  it('requires exact parity for complete error payloads', async () => {
    const test = dossier({
      expected: {}, expectedBehavior: 'reject',
      expectedError: { code: 'BAD_TYPE', field: 'value', messageIncludes: 'wrong type' },
    });
    const failure = (expected: string) => {
      throw Object.assign(new Error('wrong type'), {
        code: 'BAD_TYPE', field: 'value', expected, allowed: ['number'],
      });
    };
    const results = await executeValidationCases(test, runner(
      () => failure('finite number'),
      () => failure('finite number'),
      () => failure('integer'),
    ));
    expect(results.get('case:one')).toMatchObject({
      status: 'failed', enginePassed: true, fullMcpPassed: true, compactMcpPassed: true, parityPassed: false,
    });
  });
});
