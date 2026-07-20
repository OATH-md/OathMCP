import { describe, expect, it } from 'vitest';
import { run, runWithContract } from './run.js';
import { loadSpec } from './load-specs.js';
import { CalculationError, HardLimitError, InputError } from './errors.js';
import { getCompute, type ComputeFn } from './registry.js';

describe('run(gfr)', () => {
  it('computes a mid-range value with the correct interpretation band', () => {
    const result = run('gfr', { creatinine: 1.2, age: 55, sex: 'male' });

    expect(result.schemaVersion).toBe('1.1');
    expect(result.id).toBe('gfr');
    expect(result.version).toBe('1.0.0');
    expect(result.results[0].name).toBe('gfr');
    expect(result.results[0].value).toBeCloseTo(71.42, 2);
    expect(result.results[0].unit).toBe('mL/min/1.73m²');
    // eGFR ~71 → KDIGO G2 (mildly decreased), severity borderline.
    expect(result.interpretation?.label).toContain('G2');
    expect(result.interpretation?.severity).toBe('borderline');
    expect(result.warnings).toEqual([]);
    expect(result.evidence[0].doi).toBe('10.1056/NEJMoa2102953');
  });

  it('treats SI creatinine {value, unit} identically to the equivalent canonical bare number', () => {
    const si = run('gfr', {
      creatinine: { value: 106, unit: 'umol/L' },
      age: 55,
      sex: 'male',
    });
    const bare = run('gfr', { creatinine: 106 / 88.4, age: 55, sex: 'male' });

    expect(si.results[0].value).toBe(bare.results[0].value);
    // The echoed input is recorded in canonical units.
    expect(si.inputsUsed.creatinine.unit).toBe('mg/dL');
    expect(si.inputsUsed.creatinine.value).toBeCloseTo(106 / 88.4, 10);
    expect(si.inputProvenance.creatinine).toMatchObject({
      source: 'supplied',
      suppliedAs: 'creatinine',
      original: { value: 106, unit: 'umol/L' },
      normalized: { unit: 'mg/dL' },
    });
  });

  it('throws HardLimitError (mentioning units) for an implausible bare creatinine', () => {
    // 115 as a bare number is read as 115 mg/dL — physiologically impossible,
    // and the classic mistake of passing an SI value (µmol/L) without a unit.
    expect(() => run('gfr', { creatinine: 115, age: 55, sex: 'male' })).toThrow(
      HardLimitError,
    );
    try {
      run('gfr', { creatinine: 115, age: 55, sex: 'male' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HardLimitError);
      expect((e as HardLimitError).field).toBe('creatinine');
      expect((e as HardLimitError).message).toContain('mg/dL');
    }
  });

  it('accepts normalized micro-symbol and whitespace variants for quantity units', () => {
    const normalized = run('gfr', {
      creatinine: { value: 106, unit: 'µmol / L' },
      age: 55,
      sex: 'male',
    });
    const advertised = run('gfr', {
      creatinine: { value: 106, unit: 'umol/L' },
      age: 55,
      sex: 'male',
    });

    expect(normalized.results).toEqual(advertised.results);
    expect(normalized.inputsUsed).toEqual(advertised.inputsUsed);
    expect(normalized.inputProvenance.creatinine.original?.unit).toBe('µmol / L');
  });
});

describe('clinical model provenance', () => {
  it('warns explicitly when a model review has expired', () => {
    const spec = { ...loadSpec('bmi'), reviewAfter: '2026-01-01' };
    const result = runWithContract(spec, getCompute('bmi') as unknown as ComputeFn, { weight_kg: 70, height_cm: 170 });

    expect(result.clinicalModel).toMatchObject({ reviewAfter: '2026-01-01', stale: true });
    expect(result.warnings).toContain(
      'Clinical model review expired after 2026-01-01; verify the controlling source and data version before relying on this result.',
    );
  });
});

describe('structured input errors', () => {
  it('rejects unknown direct inputs instead of stripping a typo', () => {
    try {
      run('gfr', { creatnine: 1.2, creatinine: 1.2, age: 55, sex: 'male' });
      expect.unreachable('should have rejected the typo');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect((error as InputError).code).toBe('UNKNOWN_INPUT');
      expect((error as InputError).field).toBe('creatnine');
    }
  });

  it('reports the allowed values for an invalid enum', () => {
    try {
      run('gfr', { creatinine: 1.2, age: 55, sex: 'unknown' });
      expect.unreachable('should have rejected the enum value');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      const inputError = error as InputError;
      expect(inputError.code).toBe('BAD_ENUM');
      expect(inputError.field).toBe('sex');
      expect(inputError.allowed).toEqual(['male', 'female']);
    }
  });

  it('reports the allowed units for an unknown quantity unit', () => {
    try {
      run('gfr', {
        creatinine: { value: 1.2, unit: 'mmol/L' },
        age: 55,
        sex: 'male',
      });
      expect.unreachable('should have rejected the unit');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      const inputError = error as InputError;
      expect(inputError.code).toBe('UNKNOWN_UNIT');
      expect(inputError.field).toBe('creatinine');
      expect(inputError.allowed).toEqual(['mg/dL', 'umol/L']);
    }
  });
});

describe('compatibility aliases', () => {
  it('accepts input aliases, echoes only canonical keys, and emits compatibility warnings', () => {
    const canonical = run('map', { systolic_bp: 120, diastolic_bp: 80 });
    const aliased = run('map', { systolic: 120, diastolic: 80 });

    expect(aliased.results).toEqual(canonical.results);
    expect(aliased.inputsUsed).toEqual({
      systolic_bp: { value: 120 },
      diastolic_bp: { value: 80 },
    });
    expect(aliased.warnings).toEqual([
      "Input 'systolic' is a compatibility alias; use 'systolic_bp'.",
      "Input 'diastolic' is a compatibility alias; use 'diastolic_bp'.",
    ]);
    expect(aliased.inputProvenance.systolic_bp).toMatchObject({
      source: 'alias', suppliedAs: 'systolic', normalized: { value: 120 },
    });
  });

  it('rejects canonical-plus-alias ambiguity with structured correction details', () => {
    try {
      run('map', { systolic_bp: 120, systolic: 121, diastolic_bp: 80 });
      expect.unreachable('should have rejected ambiguous input keys');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      const inputError = error as InputError;
      expect(inputError.code).toBe('AMBIGUOUS_ALIAS');
      expect(inputError.field).toBe('systolic_bp');
      expect(inputError.expected).toBe('systolic_bp');
      expect(inputError.allowed).toEqual(['systolic_bp', 'systolic']);
    }
  });

  it('preserves the ich_volume shape compatibility alias', () => {
    const result = run('ich_volume', {
      length_cm: 3,
      width_cm: 2,
      slice_width_cm: 0.5,
      num_slices: 5,
      is_ellipsoid: true,
    });

    expect(result.results[0].value).toBe(7.5);
    expect(result.inputsUsed.ellipsoid_shape).toEqual({ value: true });
    expect(result.warnings).toContain(
      "Input 'is_ellipsoid' is a compatibility alias; use 'ellipsoid_shape'.",
    );
  });

  it('canonicalizes enum-value aliases before computation', () => {
    const canonical = run('free_water_deficit', {
      weight_kg: 70,
      current_sodium: 160,
      patient_category: 'adult_male',
    });
    const aliased = run('free_water_deficit', {
      weight_kg: 70,
      current_sodium: 160,
      patient_category: 'Adult Male (18-65 years)',
    });

    expect(aliased.results).toEqual(canonical.results);
    expect(aliased.inputsUsed.patient_category.value).toBe('adult_male');
    expect(aliased.warnings).toEqual([
      "Value 'Adult Male (18-65 years)' for 'patient_category' is a compatibility alias; use 'adult_male'.",
    ]);
  });

  it('keeps the former Child-Pugh field names as canonicalized aliases', () => {
    const result = run('child_pugh', {
      bilirubin: 'low',
      albumin: 'high',
      inr: 'low',
      ascites: 'none',
      encephalopathy: 'none',
    });

    expect(result.results.find((entry) => entry.name === 'score')?.value).toBe(5);
    expect(Object.keys(result.inputsUsed)).toEqual([
      'bilirubin_category',
      'albumin_category',
      'inr_category',
      'ascites',
      'encephalopathy',
    ]);
    expect(result.warnings).toEqual([
      "Input 'bilirubin' is a compatibility alias; use 'bilirubin_category'.",
      "Input 'albumin' is a compatibility alias; use 'albumin_category'.",
      "Input 'inr' is a compatibility alias; use 'inr_category'.",
    ]);
  });
});

describe('cross-field constraints', () => {
  it('rejects a non-physiological MAP pressure ordering', () => {
    try {
      run('map', { systolic_bp: 80, diastolic_bp: 80 });
      expect.unreachable('should have rejected equal pressures');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      const inputError = error as InputError;
      expect(inputError.code).toBe('CONSTRAINT_FAILED');
      expect(inputError.field).toBe('systolic_bp');
      expect(inputError.expected).toBe('systolic_bp > diastolic_bp');
    }
  });

  it('requires an oxygen measurement for OI/OSI', () => {
    try {
      run('oxygenation_index', { fio2: 60, mean_airway_pressure: 15 });
      expect.unreachable('should have required PaO2 or SpO2');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      const inputError = error as InputError;
      expect(inputError.code).toBe('CONSTRAINT_FAILED');
      expect(inputError.allowed).toEqual(['pao2', 'spo2']);
    }
  });

  it('enforces sodium direction and adult Watson prerequisites', () => {
    expect(() =>
      run('sodium_deficit', {
        weight_kg: 70,
        current_sodium: 130,
        desired_sodium: 125,
        age: 40,
        height_cm: 175,
        sex: 'male',
      }),
    ).toThrow(/Desired sodium must be greater/);

    try {
      run('sodium_deficit', {
        weight_kg: 70,
        current_sodium: 125,
        desired_sodium: 135,
        age: 40,
      });
      expect.unreachable('should have required adult Watson inputs');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      const inputError = error as InputError;
      expect(inputError.code).toBe('MISSING_REQUIRED');
      expect(inputError.field).toBe('height_cm');
      expect(inputError.expected).toBe('number');
    }

    expect(() =>
      run('sodium_deficit', {
        weight_kg: 70,
        current_sodium: 125,
        desired_sodium: 135,
        age: 40,
        height_cm: 175,
      }),
    ).toThrow(/Sex is required/);
  });

  it('rejects a free-water target that is not below current sodium', () => {
    expect(() =>
      run('free_water_deficit', {
        weight_kg: 70,
        current_sodium: 140,
        ideal_sodium: 140,
        patient_category: 'adult_male',
      }),
    ).toThrow(/Current sodium must be greater/);
  });
});

describe('segmented and per-output interpretations', () => {
  const noRiskFactors = {
    chf: false,
    hypertension: false,
    stroke_history: false,
    vascular_disease: false,
    diabetes: false,
  };

  it('treats female sex alone differently from a male score of one', () => {
    const femaleOnly = run('chadsvasc', {
      ...noRiskFactors,
      age_group: 'under_65',
      sex: 'female',
    });
    const maleAgePoint = run('chadsvasc', {
      ...noRiskFactors,
      age_group: 'age_65_74',
      sex: 'male',
    });

    expect(femaleOnly.results.find((entry) => entry.name === 'score')?.value).toBe(1);
    expect(maleAgePoint.results.find((entry) => entry.name === 'score')?.value).toBe(1);
    expect(femaleOnly.interpretation?.severity).toBe('normal');
    expect(femaleOnly.interpretation?.label).toContain('female sex alone');
    expect(maleAgePoint.interpretation?.severity).toBe('borderline');
  });

  it('bands OI without incorrectly applying OI thresholds to OSI', () => {
    const result = run('oxygenation_index', {
      mean_airway_pressure: 20,
      fio2: 100,
      pao2: 50,
      spo2: 85,
    });

    expect(result.results.map((entry) => entry.name)).toEqual(['oi', 'osi']);
    expect(result.interpretations?.map((entry) => entry.output)).toEqual(['oi']);
    expect(
      result.interpretations?.some((entry) => entry.output === 'osi'),
    ).toBe(false);
    const oiInterpretation = result.interpretations?.find(
      (entry) => entry.output === 'oi',
    );
    expect(result.interpretation).toEqual({
      label: oiInterpretation?.label,
      severity: oiInterpretation?.severity,
    });
  });
});

describe('structured scoring and adjustments', () => {
  it('derives score components from declared metadata', () => {
    const result = run('apgar', {
      assessment_minute: 'minute_1',
      oxygen: false, ppv_or_ncpap: false, endotracheal_tube: false,
      chest_compressions: false, epinephrine: false,
      appearance: 'pink_all_over', pulse: 'greater_than_100', grimace: 'cough_sneeze_cry',
      activity: 'active_motion', respiratory: 'strong_cry',
    });
    expect(result.scoringComponents).toHaveLength(5);
    expect(result.scoringComponents.reduce((sum, component) => sum + (component.points ?? 0), 0)).toBe(10);
  });

  it('requires an explicit carboplatin cap policy and exposes its effect', () => {
    const result = run('carboplatin_auc', {
      target_auc: 5,
      gfr: 150,
      kidney_function_method: 'ckd_epi_2009_no_race_egfr',
      kidney_function_indexing: 'absolute_ml_min',
      treatment_intent: 'non_curative',
      cap_policy: 'nci_ctep_estimated_125',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'kidney_function_absolute', value: 150 }),
      expect.objectContaining({ name: 'kidney_function_used', value: 125 }),
      expect.objectContaining({ name: 'gfr_used', value: 125 }),
      expect.objectContaining({ name: 'gfr_was_capped', value: true }),
      expect.objectContaining({ name: 'cap_policy_applied', value: 'nci_ctep_estimated_125' }),
      expect.objectContaining({ name: 'rounding_policy_applied', value: 'nearest_whole_mg_addikd_2022' }),
    ]));
  });

  it('rejects contradictory carboplatin method, indexing, and cap-policy combinations', () => {
    const base = {
      target_auc: 5,
      gfr: 90,
      treatment_intent: 'non_curative',
      rounding_policy: 'nearest_whole_mg_addikd_2022',
    };
    expect(() => run('carboplatin_auc', {
      ...base,
      kidney_function_method: 'measured_gfr',
      kidney_function_indexing: 'indexed_ml_min_1_73m2',
      patient_bsa: 1.8,
      cap_policy: 'no_cap_addikd_2022',
    })).toThrow(/measured GFR must be supplied as absolute/i);
    expect(() => run('carboplatin_auc', {
      ...base,
      kidney_function_method: 'cockcroft_gault_crcl',
      kidney_function_indexing: 'indexed_ml_min_1_73m2',
      patient_bsa: 1.8,
      cap_policy: 'no_cap_addikd_2022',
    })).toThrow(/Cockcroft-Gault creatinine clearance must be supplied as absolute/i);
    expect(() => run('carboplatin_auc', {
      ...base,
      kidney_function_method: 'measured_gfr',
      kidney_function_indexing: 'absolute_ml_min',
      cap_policy: 'nci_ctep_estimated_125',
    })).toThrow(/cap does not apply to directly measured GFR/i);
  });

  it('traces conditional, lookup, and MELD input/output bounds', () => {
    const chemo = run('chemo_dose_bsa', {
      dose_per_m2: 100, bsa: 2.5, dose_reduction: 0, cap_bsa: true,
    });
    expect(chemo.adjustments[0]).toMatchObject({
      id: 'bsa_cap_2', target: { kind: 'input', field: 'bsa' },
      original: 2.5, effective: 2, applied: true, conditionMatched: true,
      bounds: { maximum: 2 }, verifyOutput: 'bsa_used',
    });

    const kdpi = run('kdpi', {
      donor_age_years: 50, donor_height_cm: 175, donor_weight_kg: 80, donor_hypertension: false,
      donor_diabetes: false, cause_of_death_cva: false, donor_creatinine: 9,
      donation_after_circulatory_death: false,
    });
    expect(kdpi.adjustments[0]).toMatchObject({
      id: 'creatinine_cap_8', original: 9, effective: 8, applied: true,
    });
    expect(kdpi.inputsUsed.donor_creatinine?.value).toBe(9);
    expect(kdpi.inputProvenance.donor_creatinine?.normalized.value).toBe(9);

    const meld = run('meld', {
      creatinine: 0.8, bilirubin: 0.8, inr: 0.9, sodium: 140, albumin: 4,
      age: 40, sex: 'male', dialysis: false,
    });
    expect(meld.adjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'creatinine_clamp_1_3', original: 0.8, effective: 1 }),
      expect.objectContaining({ id: 'sodium_clamp_125_137', original: 140, effective: 137 }),
      expect.objectContaining({ id: 'meld_score_clamp_6_40', target: { kind: 'output', field: 'meld' }, effective: 6 }),
    ]));
    expect(meld.results[0].value).toBe(6);
  });
});

describe('run(oxygenation_index) — conditional outputs', () => {
  it('yields only an osi result for a spo2-only call (no undefined oi entry)', () => {
    const result = run('oxygenation_index', {
      spo2: 92,
      fio2: 60,
      mean_airway_pressure: 15,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe('osi');
    expect(result.results[0].value).toBeCloseTo(9.78, 2);
    expect(result.interpretation).toBeUndefined();
    expect(result.interpretations).toEqual([]);
  });

  it('yields only an oi result for a pao2-only call', () => {
    const result = run('oxygenation_index', {
      pao2: 60,
      fio2: 60,
      mean_airway_pressure: 15,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe('oi');
    expect(result.results[0].value).toBe(15);
  });

  it('throws InputError when neither pao2 nor spo2 is supplied', () => {
    expect(() =>
      run('oxygenation_index', { fio2: 60, mean_airway_pressure: 15 }),
    ).toThrow(InputError);
  });

  it('omits unavailable ABG delta ratios instead of returning a zero sentinel', () => {
    const result = run('abg', {
      ph: 7.4,
      paco2: 40,
      bicarbonate: 24,
      sodium: 140,
      chloride: 104,
    });
    expect(result.results.find((r) => r.name === 'delta_ratio')).toBeUndefined();
    expect(result.results.find((r) => r.name === 'albumin_corrected_delta_ratio')).toBeUndefined();
    expect(result.results.find((r) => r.name === 'albumin_provenance')?.value).toBe('defaulted_4_g_dl');
  });
});

describe('compute contract mutation failures', () => {
  const expectCode = (callback: () => unknown, code: string): void => {
    try {
      callback();
      throw new Error(`Expected ${code}`);
    } catch (error) {
      expect((error as CalculationError).code).toBe(code);
    }
  };

  it('rejects a wrong primitive output type through the runner', () => {
    expectCode(() => runWithContract(
      loadSpec('bmi'),
      () => ({ bmi: 'not-a-number' }),
      { weight_kg: 70, height_cm: 170 },
    ), 'BAD_OUTPUT_TYPE');
  });

  it('rejects a string outside a declared output enum through the runner', () => {
    expectCode(() => runWithContract(
      loadSpec('child_pugh'),
      () => ({
        score: 5,
        class: 'D',
        prognosis: 'Well-compensated liver disease',
      }),
      {
        bilirubin_category: 'low', albumin_category: 'high', inr_category: 'low',
        ascites: 'none', encephalopathy: 'none',
      },
    ), 'BAD_OUTPUT_TYPE');
  });

  it('rejects a computed score that disagrees with the declared component sum', () => {
    expectCode(() => runWithContract(
      loadSpec('apgar'),
      () => ({ apgar_score: 9 }),
      {
        assessment_minute: 'minute_1',
        oxygen: false, ppv_or_ncpap: false, endotracheal_tube: false,
        chest_compressions: false, epinephrine: false,
        appearance: 'pink_all_over',
        pulse: 'at_least_100',
        grimace: 'cough_sneeze_cry',
        activity: 'active_motion',
        respiratory: 'strong_cry',
      },
    ), 'BAD_OUTPUT_TYPE');
  });

  it('rejects missing and unexpectedly present conditional outputs through the runner', () => {
    const spec = loadSpec('oxygenation_index');
    expectCode(() => runWithContract(
      spec,
      () => ({}),
      { pao2: 80, fio2: 50, mean_airway_pressure: 10 },
    ), 'MISSING_OUTPUT');
    expectCode(() => runWithContract(
      spec,
      () => ({ oi: 6.25, osi: 5.43 }),
      { spo2: 92, fio2: 50, mean_airway_pressure: 10 },
    ), 'UNEXPECTED_OUTPUT');
  });

  it('rejects missing and extra computeCondition outputs through the runner', () => {
    const spec = loadSpec('neonatal_measurements');
    expectCode(() => runWithContract(
      spec,
      () => ({}),
      { gestational_age_weeks: 30 },
    ), 'MISSING_OUTPUT');
    expectCode(() => runWithContract(
      spec,
      () => ({ ett_depth_at_lip_cm: 5.5 }),
      { gestational_age_weeks: 22 },
    ), 'UNEXPECTED_OUTPUT');
  });

  it('applies declared input adjustments before invoking compute', () => {
    let observedCreatinine: unknown;
    const result = runWithContract(
      loadSpec('kdpi'),
      (inputs) => {
        observedCreatinine = inputs.donor_creatinine;
        return {
          kdpi: 20, kdri_raw: 1, kdri_scaled: 1, reference_population_year: 2025,
          mapping_as_of: '2026-04-03', interpretation: 'Injected contract probe.',
        };
      },
      {
        donor_age_years: 50, donor_height_cm: 175, donor_weight_kg: 80, donor_hypertension: false,
        donor_diabetes: false, cause_of_death_cva: false, donor_creatinine: 9,
        donation_after_circulatory_death: false,
      },
    );
    expect(observedCreatinine).toBe(8);
    expect(result.inputsUsed.donor_creatinine?.value).toBe(9);
    expect(result.inputProvenance.donor_creatinine?.normalized.value).toBe(9);
    expect(result.adjustments[0]).toMatchObject({ original: 9, effective: 8, applied: true });
  });
});
