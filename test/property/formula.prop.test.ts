/** Cross-formula dimensional and monotonicity properties. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/engine/index.js';

function numberResult(id: string, inputs: Record<string, unknown>, output: string): number {
  const value = run(id, inputs).results.find((entry) => entry.name === output)?.value;
  if (typeof value !== 'number') throw new Error(`${id}.${output} was not numeric`);
  return value;
}

function values(id: string, inputs: Record<string, unknown>): Map<string, unknown> {
  return new Map(run(id, inputs).results.map((entry) => [entry.name, entry.value]));
}

describe('formula/unit/dosing properties', () => {
  it('BMI decreases with the square of height at fixed weight', () => {
    fc.assert(fc.property(
      fc.double({ min: 20, max: 300, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 100, max: 220, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 20, noNaN: true, noDefaultInfinity: true }),
      (weight, height, delta) => {
        const short = numberResult('bmi', { weight_kg: weight, height_cm: height }, 'bmi');
        const tall = numberResult('bmi', { weight_kg: weight, height_cm: height + delta }, 'bmi');
        expect(tall).toBeLessThanOrEqual(short);
      },
    ), { numRuns: 100 });
  });

  it('both named BSA variants increase monotonically with height and weight', () => {
    fc.assert(fc.property(
      fc.double({ min: 20, max: 300, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 100, max: 240, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0.1, max: 10, noNaN: true, noDefaultInfinity: true }),
      (weight, height, delta) => {
        for (const id of ['bsa', 'bsa_dubois']) {
          const baseline = numberResult(id, { weight_kg: weight, height_cm: height }, 'bsa');
          const larger = numberResult(id, {
            weight_kg: weight + delta,
            height_cm: height + delta,
          }, 'bsa');
          expect(larger).toBeGreaterThanOrEqual(baseline);
        }
      },
    ), { numRuns: 100 });
  });

  it('the one-third MAP approximation stays between diastolic and systolic pressure', () => {
    fc.assert(fc.property(
      fc.integer({ min: 30, max: 250 }),
      fc.integer({ min: 1, max: 100 }),
      (diastolic, pulsePressure) => {
        const systolic = Math.min(400, diastolic + pulsePressure);
        fc.pre(systolic > diastolic);
        const map = numberResult('map', { systolic_bp: systolic, diastolic_bp: diastolic }, 'map');
        expect(map).toBeGreaterThanOrEqual(diastolic);
        expect(map).toBeLessThanOrEqual(systolic);
      },
    ), { numRuns: 100 });
  });

  it('adult free-water deficit scales linearly with weight at fixed sodium and category', () => {
    fc.assert(fc.property(
      fc.double({ min: 20, max: 300, noNaN: true, noDefaultInfinity: true }),
      (weight) => {
        const inputs = { current_sodium: 160, ideal_sodium: 140, patient_category: 'adult_male' };
        const baseline = numberResult('free_water_deficit', { ...inputs, weight_kg: weight }, 'free_water_deficit');
        const doubled = numberResult('free_water_deficit', { ...inputs, weight_kg: weight * 2 }, 'free_water_deficit');
        expect(Math.abs(doubled - baseline * 2)).toBeLessThanOrEqual(0.02);
      },
    ), { numRuns: 100 });
  });

  it('GIR is proportional to infusion rate and inverse to weight', () => {
    fc.assert(fc.property(
      fc.double({ min: 1, max: 200, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 25, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }),
      (weight, dextrose, rate) => {
        const baseline = numberResult('gir', {
          weight_kg: weight, dextrose_concentration: dextrose, infusion_rate: rate,
        }, 'gir');
        const doubledRate = numberResult('gir', {
          weight_kg: weight, dextrose_concentration: dextrose, infusion_rate: rate * 2,
        }, 'gir');
        const doubledWeight = numberResult('gir', {
          weight_kg: weight * 2, dextrose_concentration: dextrose, infusion_rate: rate,
        }, 'gir');
        expect(Math.abs(doubledRate - baseline * 2)).toBeLessThanOrEqual(0.02);
        expect(Math.abs(doubledWeight - baseline / 2)).toBeLessThanOrEqual(0.02);
      },
    ), { numRuns: 100 });
  });

  it('A-a difference falls with PaO2 and oxygenation index falls with PaO2', () => {
    fc.assert(fc.property(
      fc.double({ min: 30, max: 300, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 30, noNaN: true, noDefaultInfinity: true }),
      (pao2, delta) => {
        const firstAa = numberResult('aa_gradient', {
          pao2, paco2: 40, fio2: 50, age: 40,
        }, 'aa_gradient');
        const secondAa = numberResult('aa_gradient', {
          pao2: pao2 + delta, paco2: 40, fio2: 50, age: 40,
        }, 'aa_gradient');
        expect(secondAa).toBeLessThanOrEqual(firstAa);

        const firstOi = numberResult('oxygenation_index', {
          mean_airway_pressure: 15, fio2: 60, pao2,
        }, 'oi');
        const secondOi = numberResult('oxygenation_index', {
          mean_airway_pressure: 15, fio2: 60, pao2: pao2 + delta,
        }, 'oi');
        expect(secondOi).toBeLessThanOrEqual(firstOi);
      },
    ), { numRuns: 100 });
  });

  it('R-factor classification is invariant to a shared laboratory scale', () => {
    fc.assert(fc.property(
      fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0.5, max: 5, noNaN: true, noDefaultInfinity: true }),
      (alt, alp, scale) => {
        const baseline = values('r_factor', { alt, alp, alt_uln: 40, alp_uln: 120 });
        const scaled = values('r_factor', {
          alt: alt * scale,
          alp: alp * scale,
          alt_uln: 40 * scale,
          alp_uln: 120 * scale,
        });
        expect(scaled.get('r_factor')).toBe(baseline.get('r_factor'));
        expect(scaled.get('injury_type')).toBe(baseline.get('injury_type'));
      },
    ), { numRuns: 100 });
  });

  it('carboplatin dose is proportional to target AUC under a fixed explicit policy', () => {
    fc.assert(fc.property(
      fc.double({ min: 15, max: 125, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 5, noNaN: true, noDefaultInfinity: true }),
      (gfr, auc) => {
        const inputs = {
          gfr,
          kidney_function_method: 'measured_gfr',
          kidney_function_indexing: 'absolute_ml_min',
          treatment_intent: 'curative',
          cap_policy: 'no_cap_addikd_2022',
          rounding_policy: 'nearest_whole_mg_addikd_2022',
        };
        const first = numberResult('carboplatin_auc', { ...inputs, target_auc: auc }, 'dose');
        const doubled = numberResult('carboplatin_auc', { ...inputs, target_auc: auc * 2 }, 'dose');
        expect(Math.abs(doubled - first * 2)).toBeLessThanOrEqual(1.5);
      },
    ), { numRuns: 100 });
  });
});
