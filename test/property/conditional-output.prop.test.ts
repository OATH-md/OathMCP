import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/engine/index.js';

const names = (id: string, inputs: Record<string, unknown>): Set<string> =>
  new Set(run(id, inputs).results.map((entry) => entry.name));

describe('conditional output properties', () => {
  it('ABG delta ratios are present exactly when their prerequisites are met', () => {
    fc.assert(fc.property(
      fc.double({ min: 5, max: 50, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 110, max: 170, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 70, max: 130, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 6, noNaN: true, noDefaultInfinity: true }),
      (bicarbonate, sodium, chloride, albumin) => {
        const outputNames = names('abg', {
          ph: 7.3, paco2: 30, bicarbonate, sodium, chloride, albumin, sample_type: 'arterial',
        });
        const gap = sodium - (chloride + bicarbonate);
        const corrected = gap + 2.5 * (4 - albumin);
        expect(outputNames.has('delta_ratio')).toBe(gap > 12 && bicarbonate < 24);
        expect(outputNames.has('albumin_corrected_delta_ratio')).toBe(corrected > 12 && bicarbonate < 24);
      },
    ));
  });

  it('neonatal output families depend only on their owning input', () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (weight, gestation, corrected) => {
      fc.pre(weight || gestation || corrected);
      const inputs = {
        ...(weight ? { weight_grams: 999.5 } : {}),
        ...(gestation ? { gestational_age_weeks: 28, postnatal_age_hours: 12 } : {}),
        ...(corrected ? { corrected_gestational_age_weeks: 36 } : {}),
      };
      const outputNames = names('neonatal_measurements', inputs);
      expect(outputNames.has('uac_depth_estimate_cm')).toBe(weight);
      expect(outputNames.has('ett_depth_at_lip_cm')).toBe(gestation);
      expect(outputNames.has('day_one_map_mm_hg')).toBe(gestation);
      expect(outputNames.has('corrected_map_mm_hg')).toBe(corrected);
    }));
  });

  it('CSF glucose ratio requires both contemporaneous values', () => {
    for (const csf of [undefined, 2]) for (const serum of [undefined, 5]) {
      const outputNames = names('csf', {
        age_years: 40, wbc_per_ul: 2, wbc_diff: 'mixed',
        antimicrobial_pretreatment: 'no', immune_status: 'immunocompetent', imaging_context: 'not_done',
        ...(csf === undefined ? {} : { csf_glucose_mmol_l: csf }),
        ...(serum === undefined ? {} : { serum_glucose_mmol_l: serum }),
      });
      expect(outputNames.has('csf_serum_glucose_ratio')).toBe(csf !== undefined && serum !== undefined);
    }
  });
});
