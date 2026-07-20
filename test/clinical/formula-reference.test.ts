/** Independently reconstructed formula reference and safety cases. */
import { describe, expect, it } from 'vitest';
import { run } from '../../src/engine/index.js';

function values(id: string, inputs: Record<string, unknown>): Map<string, unknown> {
  return new Map(run(id, inputs).results.map((entry) => [entry.name, entry.value]));
}

describe('formula/unit/dosing clinical references', () => {
  it('uses literal SI anchors rather than the production conversion table as oracle', () => {
    const calcium = values('corrected_calcium', {
      calcium: { value: 2, unit: 'mmol/L' },
      albumin: { value: 20, unit: 'g/L' },
    });
    // 2.0 mmol/L calcium = 8.016 mg/dL using the independently pinned 4.008 factor;
    // albumin 20 g/L = 2.0 g/dL; conventional 0.8-factor adjustment rounds to 9.6 mg/dL.
    expect(calcium.get('corrected_calcium')).toBe(9.6);
    expect(calcium.get('clinical_use_supported')).toBe(false);

    const egfrSi = values('gfr', {
      creatinine: { value: 88.4, unit: 'umol/L' },
      age: 50,
      sex: 'male',
    }).get('gfr') as number;
    const egfrUs = values('gfr', { creatinine: 1, age: 50, sex: 'male' }).get('gfr') as number;
    expect(Math.abs(egfrSi - egfrUs)).toBeLessThanOrEqual(0.01);
  });

  it('does not invent albumin correction or a zero delta ratio when context is absent', () => {
    const omittedAlbumin = values('anion_gap', { sodium: 140, chloride: 104, bicarbonate: 14 });
    expect(omittedAlbumin.get('anion_gap')).toBe(22);
    expect(omittedAlbumin.has('albumin_corrected_anion_gap')).toBe(false);
    expect(omittedAlbumin.get('delta_ratio')).toBe(1);
    expect(omittedAlbumin.has('albumin_corrected_delta_ratio')).toBe(false);

    const noAcidosis = values('anion_gap', {
      sodium: 140, chloride: 105, bicarbonate: 25, albumin: 4,
    });
    expect(noAcidosis.has('delta_ratio')).toBe(false);
    expect(noAcidosis.has('albumin_corrected_delta_ratio')).toBe(false);
  });

  it('keeps Cockcroft-Gault weight selection explicit and removes inferred adjusted clearance', () => {
    const selected = values('creatinine_clearance', {
      age: 60,
      weight_kg: 110,
      creatinine: 1,
      sex: 'male',
    });
    expect(selected.get('creatinine_clearance')).toBe(122.2);
    expect(selected.has('adjusted_clearance')).toBe(false);
    expect(() => run('creatinine_clearance', {
      age: 60,
      weight_kg: 110,
      creatinine: 1,
      sex: 'male',
      height_cm: 180,
    })).toThrow(/Unknown input 'height_cm'/);
    expect(() => run('creatinine_clearance', {
      age: 17,
      weight_kg: 70,
      creatinine: 1,
      sex: 'male',
    })).toThrow(/Age 17 is outside physiological limits \[18, 120\]/);
  });

  it('limits the water and sodium-content estimates to their verified adult variants', () => {
    expect(() => run('free_water_deficit', {
      weight_kg: 20,
      current_sodium: 150,
      patient_category: 'child',
    })).toThrow(/Patient Category must be one of/);

    expect(() => run('sodium_deficit', {
      weight_kg: 20,
      current_sodium: 120,
      desired_sodium: 130,
      age: 10,
      height_cm: 130,
      sex: 'male',
    })).toThrow(/Age 10 is outside physiological limits \[18, 120\]/);
  });

  it('keeps Mosteller and DuBois as explicit unstaged BSA variants', () => {
    const mosteller = run('bsa', { height_cm: 170, weight_kg: 70 });
    const dubois = run('bsa_dubois', { height_cm: 170, weight_kg: 70 });
    expect(mosteller.results[0]?.value).toBe(1.82);
    expect(dubois.results[0]?.value).toBe(1.81);
    expect(mosteller.interpretations).toEqual([]);
    expect(dubois.interpretations).toEqual([]);
  });

  it('makes carboplatin method, indexing, intent, and cap policy explicit', () => {
    const measured = values('carboplatin_auc', {
      target_auc: 5,
      gfr: 130,
      kidney_function_method: 'measured_gfr',
      kidney_function_indexing: 'absolute_ml_min',
      treatment_intent: 'curative',
      cap_policy: 'no_cap_addikd_2022',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    });
    expect(measured.get('kidney_function_used')).toBe(130);
    expect(measured.get('dose')).toBe(775);
    expect(measured.get('gfr_was_capped')).toBe(false);

    const protocolCapped = values('carboplatin_auc', {
      target_auc: 5,
      gfr: 130,
      kidney_function_method: 'ckd_epi_2009_no_race_egfr',
      kidney_function_indexing: 'absolute_ml_min',
      treatment_intent: 'non_curative',
      cap_policy: 'nci_ctep_estimated_125',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    });
    expect(protocolCapped.get('kidney_function_used')).toBe(125);
    expect(protocolCapped.get('dose')).toBe(750);
    expect(protocolCapped.get('gfr_was_capped')).toBe(true);

    const rounded = values('carboplatin_auc', {
      target_auc: 5,
      gfr: 90.26,
      kidney_function_method: 'measured_gfr',
      kidney_function_indexing: 'absolute_ml_min',
      treatment_intent: 'curative',
      cap_policy: 'no_cap_addikd_2022',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    });
    expect(rounded.get('dose')).toBe(576);
    expect(rounded.get('rounding_policy_applied')).toBe('nearest_whole_mg_addikd_2022');

    const indexedAboveCap = values('carboplatin_auc', {
      target_auc: 5,
      gfr: 120,
      kidney_function_method: 'ckd_epi_2009_no_race_egfr',
      kidney_function_indexing: 'indexed_ml_min_1_73m2',
      patient_bsa: 2,
      treatment_intent: 'non_curative',
      cap_policy: 'nci_ctep_estimated_125',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    });
    expect(indexedAboveCap.get('kidney_function_absolute')).toBe(138.73);
    expect(indexedAboveCap.get('kidney_function_used')).toBe(125);
    expect(indexedAboveCap.get('gfr_was_capped')).toBe(true);

    const indexedBelowCap = values('carboplatin_auc', {
      target_auc: 5,
      gfr: 130,
      kidney_function_method: 'ckd_epi_2009_no_race_egfr',
      kidney_function_indexing: 'indexed_ml_min_1_73m2',
      patient_bsa: 1.2,
      treatment_intent: 'non_curative',
      cap_policy: 'nci_ctep_estimated_125',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    });
    expect(indexedBelowCap.get('kidney_function_absolute')).toBe(90.17);
    expect(indexedBelowCap.get('kidney_function_used')).toBe(90.17);
    expect(indexedBelowCap.get('gfr_was_capped')).toBe(false);

    const indexed = values('carboplatin_auc', {
      target_auc: 6,
      gfr: 100,
      kidney_function_method: 'ckd_epi_2009_no_race_egfr',
      kidney_function_indexing: 'indexed_ml_min_1_73m2',
      patient_bsa: 2.076,
      treatment_intent: 'non_curative',
      cap_policy: 'no_cap_addikd_2022',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    });
    expect(indexed.get('kidney_function_absolute')).toBe(120);
    expect(indexed.get('dose')).toBe(870);
    expect(indexed.get('indexed_conversion_applied')).toBe(true);
  });

  it('reproduces source-bound respiratory formula anchors and conditional outputs', () => {
    const seaLevel = values('aa_gradient', {
      pao2: 90, paco2: 40, fio2: 21, age: 40,
    });
    expect(seaLevel.get('aa_gradient')).toBe(9.85);
    expect(seaLevel.get('expected_gradient')).toBe(14);

    const oiOnly = values('oxygenation_index', {
      mean_airway_pressure: 15, fio2: 80, pao2: 60,
    });
    expect(oiOnly.get('oi')).toBe(20);
    expect(oiOnly.has('osi')).toBe(false);

    const osiOnly = values('oxygenation_index', {
      mean_airway_pressure: 12, fio2: 60, spo2: 90,
    });
    expect(osiOnly.get('osi')).toBe(8);
    expect(osiOnly.has('oi')).toBe(false);
  });

  it('keeps the source-defined R-factor boundaries exact', () => {
    expect(values('r_factor', { alt: 80, alp: 120, alt_uln: 40, alp_uln: 120 }).get('injury_type')).toBe('Cholestatic');
    expect(values('r_factor', { alt: 120, alp: 180, alt_uln: 40, alp_uln: 120 }).get('injury_type')).toBe('Cholestatic');
    expect(values('r_factor', { alt: 120, alp: 150, alt_uln: 40, alp_uln: 120 }).get('injury_type')).toBe('Mixed');
    expect(values('r_factor', { alt: 200, alp: 120, alt_uln: 40, alp_uln: 120 }).get('injury_type')).toBe('Hepatocellular');
  });

  it('applies a BSA cap only when the governing protocol explicitly requests it', () => {
    const uncapped = values('chemo_dose_bsa', {
      dose_per_m2: 175, bsa: 2.4, cap_bsa: false,
    });
    expect(uncapped.get('final_dose')).toBe(420);
    expect(uncapped.get('bsa_was_capped')).toBe(false);

    const capped = values('chemo_dose_bsa', {
      dose_per_m2: 175, bsa: 2.4, cap_bsa: true, dose_reduction: 25,
    });
    expect(capped.get('calculated_dose')).toBe(350);
    expect(capped.get('final_dose')).toBe(262.5);
    expect(capped.get('bsa_was_capped')).toBe(true);
  });

  it('requires BSA for indexed carboplatin kidney function', () => {
    expect(() => run('carboplatin_auc', {
      target_auc: 5,
      gfr: 90,
      kidney_function_method: 'ckd_epi_2009_no_race_egfr',
      kidney_function_indexing: 'indexed_ml_min_1_73m2',
      treatment_intent: 'non_curative',
      cap_policy: 'no_cap_addikd_2022',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    })).toThrow(/Patient BSA is required/);
  });

  it('returns MAP as a waveform-dependent estimate without universal staging', () => {
    const result = run('map', { systolic_bp: 120, diastolic_bp: 80 });
    expect(result.results[0]?.value).toBe(93.33);
    expect(result.interpretations).toEqual([]);
  });

  it('does not substitute unsupported ABC/3 for irregular hemorrhages', () => {
    const common = {
      length_cm: 4,
      width_cm: 3,
      slice_width_cm: 0.5,
      num_slices: 8,
    };
    expect(values('ich_volume', { ...common, ellipsoid_shape: true }).get('volume_ml')).toBe(24);
    expect(values('ich_volume', { ...common, ellipsoid_shape: false }).get('volume_ml')).toBe(24);
  });
});
