import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { loadSpec } from '../../src/engine/load-specs.js';
import { run } from '../../src/engine/run.js';

describe('score properties', () => {
  it('Wells is the declared boolean sum including the -2 alternative diagnosis', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }), (flags) => {
      const fields = ['active_cancer', 'paralysis_or_cast', 'bedridden', 'localized_tenderness',
        'entire_leg_swollen', 'calf_swelling', 'pitting_edema', 'collateral_veins',
        'alternative_diagnosis', 'previously_diagnosed'];
      const inputs = Object.fromEntries(fields.map((field, index) => [field, flags[index]]));
      const result = run('wells_dvt', inputs);
      const score = result.results.find((entry) => entry.name === 'score')?.value;
      const expected = flags.reduce((sum, flag, index) => sum + (flag ? (index === 8 ? -2 : 1) : 0), 0);
      expect(score).toBe(expected);
      expect(result.scoringComponents.reduce((sum, component) => sum + (component.points ?? 0), 0)).toBe(expected);
    }));
  });

  it('qSOFA changes only at RR 22 and SBP 100', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 120 }), fc.integer({ min: 0, max: 400 }), fc.boolean(),
      (respiratoryRate, systolicBp, altered) => {
        const result = run('qsofa', { respiratory_rate: respiratoryRate, systolic_bp: systolicBp, altered_mental_status: altered });
        expect(result.results.find((entry) => entry.name === 'score')?.value)
          .toBe(Number(respiratoryRate >= 22) + Number(systolicBp <= 100) + Number(altered));
      },
    ));
  });

  it.each([
    ['apgar', {
      assessment_minute: 'minute_5', oxygen: false, ppv_or_ncpap: false,
      endotracheal_tube: false, chest_compressions: false, epinephrine: false,
    }, 'apgar_score'],
    ['gcs', { assessment_context: 'general_consciousness', modifier_context: 'none' }, 'gcs_total'],
    ['nihss', { assessment_timing: 'baseline', modifier_context: 'none' }, 'nihss_score'],
    ['morse_fall_scale', {}, 'mfs_score'],
    ['gad7', {}, 'gad7_score'],
    ['mews', {}, 'mews_score'],
    ['pews', {}, 'pews_score'],
    ['child_pugh', {}, 'score'],
    ['chadsvasc', {}, 'score'],
    ['timi', {}, 'score'],
  ] as const)('%s total equals its declared component sum for arbitrary scorable choices', (id, context, output) => {
    const spec = loadSpec(id);
    const components = spec.scoring?.components ?? [];
    const choices = components.map((component): Array<{ value: unknown; points: number }> => {
      const input = spec.inputs[component.field];
      if (component.kind === 'enum' && input.kind === 'enum') {
        return input.enumValues
          .filter((option) => option.scorable !== false && option.points !== undefined)
          .map((option) => ({ value: option.value, points: option.points ?? 0 }));
      }
      if (component.kind === 'boolean' && input.kind === 'boolean') {
        return [
          { value: false, points: component.falsePoints },
          { value: true, points: component.truePoints },
        ];
      }
      throw new Error(`${id}.${component.field} has an unsupported score component`);
    });
    fc.assert(fc.property(
      fc.array(fc.nat(), { minLength: components.length, maxLength: components.length }),
      (indices) => {
        const inputs: Record<string, unknown> = { ...context };
        let expected = 0;
        components.forEach(({ field }, index) => {
          const choice = choices[index][(indices[index] ?? 0) % choices[index].length];
          inputs[field] = choice.value;
          expected += choice.points;
        });
        const result = run(id, inputs);
        expect(result.results.find((entry) => entry.name === output)?.value).toBe(expected);
        expect(result.scoringComponents.reduce((sum, component) => sum + (component.points ?? 0), 0)).toBe(expected);
      },
    ));
  });

  it('derives every non-gallstone Ranson threshold from raw observations', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 11, maxLength: 11 }), (met) => {
      const inputs = {
        etiology_variant: 'non_gallstone', assessment_hours: 48,
        admission_observed_at_hours: 0, followup_observed_at_hours: 48,
        wbc_admission: met[0] ? 16001 : 16000,
        age_years: met[1] ? 56 : 55,
        glucose_admission: met[2] ? 201 : 200,
        ast_admission: met[3] ? 251 : 250,
        ldh_admission: met[4] ? 351 : 350,
        hematocrit_admission: 45,
        bun_admission: 15,
        hematocrit_followup: met[5] ? 34.9 : 35,
        bun_followup: met[6] ? 20.1 : 20,
        calcium_followup: met[7] ? 7.9 : 8,
        pao2_followup: met[8] ? 59.9 : 60,
        base_deficit_followup: met[9] ? 4.1 : 4,
        fluid_sequestration_followup: met[10] ? 6.1 : 6,
      };
      const result = run('ranson', inputs);
      expect(result.results.find((entry) => entry.name === 'score')?.value)
        .toBe(met.reduce((sum, value) => sum + Number(value), 0));
    }));
  });

  it('derives every gallstone Ranson threshold and keeps pAO2 not applicable', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }), (met) => {
      const inputs = {
        etiology_variant: 'gallstone', assessment_hours: 48,
        admission_observed_at_hours: 0, followup_observed_at_hours: 48,
        wbc_admission: met[0] ? 18001 : 18000,
        age_years: met[1] ? 71 : 70,
        glucose_admission: met[2] ? 221 : 220,
        ast_admission: met[3] ? 251 : 250,
        ldh_admission: met[4] ? 401 : 400,
        hematocrit_admission: 45,
        bun_admission: 15,
        hematocrit_followup: met[5] ? 34.9 : 35,
        bun_followup: met[6] ? 17.1 : 17,
        calcium_followup: met[7] ? 7.9 : 8,
        base_deficit_followup: met[8] ? 5.1 : 5,
        fluid_sequestration_followup: met[9] ? 4.1 : 4,
      };
      const result = run('ranson', inputs);
      expect(result.results.find((entry) => entry.name === 'score')?.value)
        .toBe(met.reduce((sum, value) => sum + Number(value), 0));
      const provenance = result.results.find((entry) => entry.name === 'criterion_provenance')?.value;
      expect(provenance).toEqual(expect.arrayContaining([
        expect.objectContaining({ criterion: 'pao2', state: 'not_applicable' }),
      ]));
    }));
  });

});
