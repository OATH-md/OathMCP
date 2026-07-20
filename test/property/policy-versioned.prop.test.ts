import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/engine/index.js';

function numericResult(id: string, inputs: Record<string, unknown>, output: string): number {
  const result = run(id, inputs).results.find((entry) => entry.name === output)?.value;
  if (typeof result !== 'number') throw new Error(`${id}.${output} was not numeric`);
  return result;
}

describe('policy/versioned model properties', () => {
  it('EOS at-birth risk is non-decreasing as selected baseline incidence rises', () => {
    fc.assert(fc.property(
      fc.constantFrom('original_2017_nonuniversal_gbs', 'updated_2024_universal_gbs'),
      fc.double({ min: 35, max: 42, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 35.5, max: 40, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0, max: 120, noNaN: true, noDefaultInfinity: true }),
      (modelVersion, gestationalAge, temperature, romHours) => {
        const common = {
          model_version: modelVersion, temperature, rom_hours: romHours,
          gestational_age: gestationalAge, antibiotic_status: 'none',
          gbs_status: 'negative', clinical_appearance: 'well_appearing',
        };
        const low = numericResult('eos', { ...common, baseline_incidence: '0.3' }, 'risk_at_birth_per_1000');
        const high = numericResult('eos', { ...common, baseline_incidence: '0.6' }, 'risk_at_birth_per_1000');
        expect(high).toBeGreaterThanOrEqual(low);
      },
    ), { numRuns: 100 });
  });

  it('MELD adolescent output is invariant to the adult sex field', () => {
    fc.assert(fc.property(
      fc.double({ min: 1, max: 3, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 20, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 5, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 125, max: 137, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1.5, max: 3.5, noNaN: true, noDefaultInfinity: true }),
      fc.integer({ min: 12, max: 17 }),
      (creatinine, bilirubin, inr, sodium, albumin, ageAtRegistration) => {
        const common = {
          creatinine, bilirubin, inr, sodium, albumin,
          age_at_registration: ageAtRegistration, dialysis: false,
        };
        const female = numericResult('meld', { ...common, sex: 'female' }, 'meld');
        const male = numericResult('meld', { ...common, sex: 'male' }, 'meld');
        expect(female).toBe(male);
      },
    ), { numRuns: 100 });
  });
});
