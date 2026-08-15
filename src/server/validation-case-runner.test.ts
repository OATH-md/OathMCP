import { describe, expect, it } from 'vitest';
import { executeValidationCases } from '../validation/case-runner.js';
import { ValidationDossierSchema } from '../validation/schema.js';
import { createValidationCaseRunner, throwClinicalSurfaceFailure } from './validation-case-runner.js';

function thrownBy(operation: () => never): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw.');
}

describe('production validation case runner', () => {
  it('executes engine, full direct MCP, and compact MCP with exact parity', async () => {
    const dossier = ValidationDossierSchema.parse({
      calculatorId: 'bmi',
      specVersion: '1.0.0',
      clinicalModel: 'Body Mass Index (BMI)',
      variant: 'adult',
      population: 'adults',
      setting: 'screening',
      assessmentTiming: 'current',
      endpoint: 'BMI',
      reviewGroup: 'formula_unit_dosing',
      enrollment: 'pending_independent_review',
      searchRecords: [],
      authoritySourceIds: [],
      claims: [{
        id: 'claim:bmi:formula',
        kind: 'formula',
        statement: 'BMI is weight divided by squared height.',
        covers: ['formula:implementation'],
        status: 'supported',
        sourceIds: ['source:test'],
        locators: [{ sourceId: 'source:test', locator: 'equation' }],
        executable: true,
        scenarioIds: ['case:bmi:reference'],
        reviewedAt: '2026-07-15',
        reviewBy: '2027-07-15',
      }],
      cases: [{
        kind: 'reference',
        id: 'case:bmi:reference',
        tags: ['calculator:bmi:core'],
        inputs: { weight_kg: 70, height_cm: 170 },
        expected: { bmi: 24.22 },
        expectedBehavior: 'calculate',
        tolerance: { mode: 'absolute', value: 0.01, rationale: 'published precision' },
        claimIds: ['claim:bmi:formula'],
        sourceIds: ['source:test'],
        witnesses: ['formula:implementation'],
      }],
      explicitBlockers: [],
    });
    const runner = await createValidationCaseRunner();
    try {
      const result = (await executeValidationCases(dossier, runner)).get('case:bmi:reference');
      expect(result).toMatchObject({
        status: 'passed',
        enginePassed: true,
        fullMcpPassed: true,
        compactMcpPassed: true,
        parityPassed: true,
      });
    } finally {
      await runner.close();
    }
  });

  it('normalizes schema-boundary failures to the same clinical error discriminant', async () => {
    const runner = await createValidationCaseRunner();
    try {
      for (const operation of [runner.runEngine, runner.runFullMcp, runner.runCompactMcp]) {
        await expect(operation('bmi', { height_cm: 170 })).rejects.toMatchObject({
          code: 'MISSING_REQUIRED',
          field: 'weight_kg',
          message: 'Weight is required.',
          expected: 'number',
        });
        await expect(operation('bmi', { weight_kg: 70 })).rejects.toMatchObject({
          code: 'MISSING_REQUIRED',
          field: 'height_cm',
          message: 'Height is required.',
          expected: 'number',
        });
        await expect(operation('ibw', { height_cm: 180 })).rejects.toMatchObject({
          code: 'MISSING_REQUIRED',
          field: 'sex',
          message: 'Sex is required.',
          expected: 'enum',
        });
        await expect(operation('corrected_calcium', { calcium: 8 })).rejects.toMatchObject({
          code: 'MISSING_REQUIRED',
          field: 'albumin',
          message: 'Albumin is required.',
          expected: 'quantity',
        });
        await expect(operation('bmi', { weight_kg: 70, height_cm: 170, extra: 1 })).rejects.toMatchObject({
          code: 'UNKNOWN_INPUT',
          field: 'extra',
          message: "Unknown input 'extra' for Body Mass Index (BMI).",
          expected: 'height_cm | weight | weight_kg',
        });
        await expect(operation('gfr', {
          creatinine: { value: 1, unit: 'bogus' },
          age: 60,
          sex: 'male',
        })).rejects.toMatchObject({
          code: 'UNKNOWN_UNIT',
          field: 'creatinine',
          message: "Unit 'bogus' is not accepted for Serum Creatinine.",
          expected: 'mg/dL | umol/L',
          allowed: ['mg/dL', 'umol/L'],
        });
        await expect(operation('gfr', {
          creatinine: { value: 0, unit: 'mg/dL' },
          age: 60,
          sex: 'male',
        })).rejects.toMatchObject({
          code: 'OUT_OF_HARD_LIMITS',
          field: 'creatinine',
          message: 'Serum Creatinine 0 mg/dL is outside physiological limits [0.01, 60] mg/dL.',
          expected: '0.01–60 mg/dL',
          min: 0.01,
          max: 60,
        });
        await expect(operation('gfr', {
          creatinine: { value: 1 },
          age: 60,
          sex: 'male',
        })).rejects.toMatchObject({
          code: 'BAD_TYPE',
          field: 'creatinine',
          message: 'Serum Creatinine must be a finite number in mg/dL or { value, unit }.',
          expected: 'number | { value, unit: mg/dL | umol/L }',
        });
        await expect(operation('bmi', {
          weight_kg: 70,
          weight: 70,
          height_cm: 170,
        })).rejects.toMatchObject({
          code: 'AMBIGUOUS_ALIAS',
          field: 'weight_kg',
          message: 'Provide weight_kg once; do not combine it with compatibility aliases.',
          expected: 'weight_kg',
          allowed: ['weight_kg', 'weight'],
        });
      }
    } finally {
      await runner.close();
    }
  });

  it('does not canonicalize an incongruent field or drifted engine error payload', () => {
    const wrongField = Object.assign(new Error('Required input: height_cm'), {
      code: 'BAD_TYPE', field: 'height_cm', expected: 'number',
    });
    expect(() => throwClinicalSurfaceFailure('bmi', { height_cm: 170 }, wrongField))
      .toThrow('Required input: height_cm');

    const wrongKind = Object.assign(new Error('Too small: expected number to be >=0.5'), {
      code: 'OUT_OF_HARD_LIMITS', field: 'weight_kg', expected: '0.5–700',
    });
    expect(() => throwClinicalSurfaceFailure('bmi', { height_cm: 170 }, wrongKind))
      .toThrow('Too small: expected number to be >=0.5');

    const driftedPayload = Object.assign(new Error('drifted public message'), {
      code: 'MISSING_REQUIRED', field: 'weight_kg', expected: 'different expectation',
    });
    expect(() => throwClinicalSurfaceFailure('bmi', { height_cm: 170 }, driftedPayload))
      .toThrow('drifted public message');

    const wrongTool = new Error(
      'Input validation error: Invalid arguments for tool calculate_gfr: height_cm: Invalid input: expected number, received undefined',
    );
    expect(() => throwClinicalSurfaceFailure('bmi', { weight_kg: 70 }, wrongTool))
      .toThrow('Invalid arguments for tool calculate_gfr');
  });

  it('normalizes v2 humanized and dotted Standard Schema paths', () => {
    expect(thrownBy(() => throwClinicalSurfaceFailure(
      'bmi',
      { weight_kg: 70 },
      new Error('Input validation error: Invalid arguments for tool calculate_bmi: height_cm: Invalid input: expected number, received undefined'),
    ))).toMatchObject({ code: 'MISSING_REQUIRED', field: 'height_cm' });

    expect(thrownBy(() => throwClinicalSurfaceFailure(
      'bmi',
      { weight_kg: 0.4, height_cm: 170 },
      new Error('Input validation error: Invalid arguments for tool calculate_bmi: weight_kg: Too small: expected number to be >=0.5'),
    ))).toMatchObject({ code: 'OUT_OF_HARD_LIMITS', field: 'weight_kg' });

    expect(thrownBy(() => throwClinicalSurfaceFailure(
      'gfr',
      { creatinine: { value: 1, unit: 'bogus' }, age: 60, sex: 'male' },
      new Error('Input validation error: Invalid arguments for tool calculate_gfr: creatinine.unit: Expected one of: mg/dL | umol/L'),
    ))).toMatchObject({ code: 'UNKNOWN_UNIT', field: 'creatinine' });

    expect(thrownBy(() => throwClinicalSurfaceFailure(
      'gfr',
      { creatinine: { value: 0, unit: 'mg/dL' }, age: 60, sex: 'male' },
      new Error('Input validation error: Invalid arguments for tool calculate_gfr: creatinine.value: Expected 0.01–60 mg/dL'),
    ))).toMatchObject({ code: 'OUT_OF_HARD_LIMITS', field: 'creatinine' });
  });
});
