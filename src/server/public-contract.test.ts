import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { loadSpec } from '../engine/index.js';
import { run } from '../engine/run.js';
import { connectInMemoryClient } from './in-memory-client.js';
import {
  buildCalculatorDescriptor,
  buildCalculatorInputSchema,
  buildCalcResultSchema,
  buildCompactDispatchResultSchema,
  buildPanelResultSchema,
  calculatorDescriptorSchema,
} from './public-contract.js';

describe('public MCP contracts', () => {
  it('builds a curated descriptor without fixtures, prompt templates, or inline evidence', () => {
    const descriptor = buildCalculatorDescriptor(loadSpec('abg'));
    expect(calculatorDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(descriptor).toMatchObject({
      id: 'abg',
      clinicalModel: { modelId: 'abg_deterministic_findings' },
      applicability: { exclusions: expect.any(Array) },
      evidenceUri: 'calc://abg/evidence',
      reviewState: { state: 'scenario_verified' },
    });
    expect(descriptor.inputs.sample_type.options?.[0]).toMatchObject({
      value: 'arterial',
      label: 'Arterial',
    });
    expect(descriptor.inputs.venous_sample?.deprecated).toBe(true);
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain(['golden', 'Tests'].join(''));
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('template');
    expect(serialized).not.toContain('citation');
  });

  it('exports draft-07 object schemas for canonical input and exact output values', () => {
    const spec = loadSpec('oxygenation_index');
    const input = z.toJSONSchema(buildCalculatorInputSchema(spec), {
      target: 'draft-07',
      io: 'input',
    }) as { type?: string; properties?: Record<string, unknown>; additionalProperties?: boolean };
    const output = z.toJSONSchema(buildCalcResultSchema(spec), {
      target: 'draft-07',
      io: 'output',
    }) as { type?: string; properties?: Record<string, unknown> };
    expect(input.type).toBe('object');
    expect(input.additionalProperties).toBe(false);
    expect(input.properties).toHaveProperty('pao2');
    expect(input.properties).not.toHaveProperty('PaO2');
    expect(output.type).toBe('object');
    expect(output.properties).toHaveProperty('results');
    expect(output.properties).toHaveProperty('evidenceUri');
  });

  it('uses the published input schema as the real runtime parser', () => {
    const gfr = buildCalculatorInputSchema(loadSpec('gfr'));
    expect(gfr.safeParse({}).success).toBe(false);
    expect(gfr.safeParse({ creatinine: 'one', age: 50, sex: 'male' }).success).toBe(false);
    expect(gfr.safeParse({ creatinine: 1, age: 50, sex: 'male' }).success).toBe(true);

    const abg = buildCalculatorInputSchema(loadSpec('abg'));
    expect(abg.safeParse({
      pH: 7.4, PaCO2: 40, HCO3: 24, Na: 140, Cl: 104,
    }).success).toBe(true);
    expect(abg.safeParse({
      ph: 7.4, pH: 7.4, paco2: 40, bicarbonate: 24, sodium: 140, chloride: 104,
    }).success).toBe(false);

    expect(gfr.safeParse({
      creatinine: { value: 88.4, unit: 'µmol / L' }, age: 50, sex: 'male',
    }).success).toBe(true);

    const narrowed = structuredClone(loadSpec('gfr'));
    const creatinine = narrowed.inputs.creatinine;
    if (creatinine?.kind !== 'quantity') throw new Error('GFR creatinine must remain a quantity input.');
    creatinine.quantity.acceptedUnits = ['mg/dL'];
    expect(buildCalculatorInputSchema(narrowed).safeParse({
      creatinine: { value: 88.4, unit: 'umol/L' }, age: 50, sex: 'male',
    }).success).toBe(false);
  });

  it('keeps reviewed safe aliases executable through full direct and compact dispatch', async () => {
    const [full, compact] = await Promise.all([
      connectInMemoryClient('public-contract-full-alias', { mode: 'full' }),
      connectInMemoryClient('public-contract-compact-alias', { mode: 'compact' }),
    ]);
    try {
      const [direct, dispatched] = await Promise.all([
        full.client.callTool({ name: 'calculate_bmi', arguments: { weight: 70, height_cm: 170 } }),
        compact.client.callTool({
          name: 'calculate',
          arguments: { id: 'bmi', inputs: { weight: 70, height_cm: 170 } },
        }),
      ]);
      expect(direct.isError).not.toBe(true);
      expect(dispatched.isError).not.toBe(true);
      expect(direct.structuredContent).toMatchObject({ id: 'bmi' });
      expect(dispatched.structuredContent).toMatchObject({ result: { calculator: 'bmi', ok: true } });
    } finally {
      await Promise.all([full.close(), compact.close()]);
    }
  });

  it('keeps panel and compact dispatch schemas top-level objects', () => {
    for (const schema of [buildPanelResultSchema(), buildCompactDispatchResultSchema()]) {
      const json = z.toJSONSchema(schema, { target: 'draft-07', io: 'output' }) as {
        type?: string;
        anyOf?: unknown;
        oneOf?: unknown;
      };
      expect(json.type).toBe('object');
      expect(json.anyOf).toBeUndefined();
      expect(json.oneOf).toBeUndefined();
    }
  });

  it('publishes Ranson observation metadata and validates criterion provenance', () => {
    const spec = loadSpec('ranson');
    const descriptor = buildCalculatorDescriptor(spec);
    expect(descriptor.inputs.hematocrit_followup?.observation).toEqual({
      phase: 'follow_up',
      timestampField: 'followup_observed_at_hours',
      derivation: 'change_from_baseline',
      baselineField: 'hematocrit_admission',
    });
    expect(descriptor.outputs.criterion_provenance?.kind).toBe('criterion_list');

    const result = runRansonEquality();
    expect(buildCalcResultSchema(spec).safeParse({ ...result, evidenceUri: 'calc://ranson/evidence' }).success).toBe(true);
    const criteria = result.results.find((entry) => entry.name === 'criterion_provenance')?.value;
    expect(criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterion: 'hematocrit_drop', state: 'not_met', observedInputs: expect.any(Array) }),
      expect.objectContaining({ criterion: 'pao2', state: 'not_met', observedInputs: ['pao2_followup'] }),
    ]));
  });
});

function runRansonEquality() {
  const spec = loadSpec('ranson');
  const schema = buildCalculatorInputSchema(spec);
  const inputs = {
    etiology_variant: 'non_gallstone', assessment_hours: 48,
    admission_observed_at_hours: 0, followup_observed_at_hours: 48,
    age_years: 55, wbc_admission: 16000, glucose_admission: 200,
    ast_admission: 250, ldh_admission: 350, hematocrit_admission: 45,
    bun_admission: 15, hematocrit_followup: 35, bun_followup: 20,
    calcium_followup: 8, pao2_followup: 60, base_deficit_followup: 4,
    fluid_sequestration_followup: 6,
  };
  expect(schema.safeParse(inputs).success).toBe(true);
  return run('ranson', inputs);
}
