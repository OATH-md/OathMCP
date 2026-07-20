import { describe, expect, it } from 'vitest';
import { loadSpec } from '../../src/engine/load-specs.js';
import { run, type CalcResult } from '../../src/engine/run.js';
import { loadAuthoritativeReferenceCases, loadValidationDossiers } from '../../src/validation/load-validation.js';

function resultValue(result: CalcResult, output: string): unknown {
  return result.results.find((entry) => entry.name === output)?.value;
}

describe('source-derived additive-score counterexamples', () => {
  it.each(['minute_1', 'minute_5', 'minute_10', 'minute_15', 'minute_20'] as const)('records APGAR at %s without a resuscitation directive', (assessmentMinute) => {
    const result = run('apgar', {
      assessment_minute: assessmentMinute,
      oxygen: false, ppv_or_ncpap: false, endotracheal_tube: false, chest_compressions: false, epinephrine: false,
      appearance: 'pink_all_over', pulse: 'at_least_100', grimace: 'cough_sneeze_cry',
      activity: 'active_motion', respiratory: 'strong_cry',
    });
    expect(resultValue(result, 'apgar_score')).toBe(10);
    expect(result.interpretation?.label.toLowerCase()).not.toMatch(/start|immediate resuscitation|required/);
  });

  it('maps the legacy APGAR >100 token safely to the exact >=100 category', () => {
    const result = run('apgar', {
      assessment_minute: 'minute_1',
      oxygen: false, ppv_or_ncpap: false, endotracheal_tube: false, chest_compressions: false, epinephrine: false,
      appearance: 'blue_or_pale',
      pulse: 'greater_than_100', grimace: 'no_response', activity: 'limp', respiratory: 'absent',
    });
    expect(result.inputsUsed.pulse?.value).toBe('at_least_100');
    expect(result.results.find((entry) => entry.name === 'apgar_score')?.value).toBe(2);
  });

  it('preserves concurrent expanded-form resuscitation checkboxes independently', () => {
    const result = run('apgar', {
      assessment_minute: 'minute_5',
      oxygen: true, ppv_or_ncpap: true, endotracheal_tube: true, chest_compressions: true, epinephrine: true,
      appearance: 'body_pink_extremities_blue', pulse: 'less_than_100', grimace: 'grimace',
      activity: 'some_flexion', respiratory: 'weak_or_irregular',
    });
    expect(result.results.find((entry) => entry.name === 'apgar_score')?.value).toBe(5);
    expect(result.inputsUsed).toMatchObject({
      oxygen: { value: true }, ppv_or_ncpap: { value: true }, endotracheal_tube: { value: true },
      chest_compressions: { value: true }, epinephrine: { value: true },
    });
  });

  it('rejects unsupported APGAR assessment minutes', () => {
    expect(() => run('apgar', {
      assessment_minute: 'minute_2',
      oxygen: false, ppv_or_ncpap: false, endotracheal_tube: false, chest_compressions: false, epinephrine: false,
      appearance: 'pink_all_over', pulse: 'at_least_100', grimace: 'cough_sneeze_cry',
      activity: 'active_motion', respiratory: 'strong_cry',
    } as never)).toThrow();
  });

  it('enrolls and executes every declared option for the source-verified score forms', () => {
    const dossiers = loadValidationDossiers();
    for (const id of ['apgar', 'gcs', 'nihss', 'morse_fall_scale', 'gad7', 'mews', 'pews', 'child_pugh', 'chadsvasc', 'timi', 'wells_dvt', 'ranson'] as const) {
      const spec = loadSpec(id);
      const dossier = dossiers.get(id);
      expect(dossier).toBeDefined();
      for (const [field, input] of Object.entries(spec.inputs)) {
        if (input.kind !== 'enum') continue;
        for (const option of input.enumValues) {
          const testCase = dossier?.cases.find((entry) =>
            entry.id === `case:${id}:option-${field}-${option.value}`);
          expect(testCase, `${id}.${field}.${option.value}`).toBeDefined();
          expect(() => run(id, testCase?.inputs ?? {})).not.toThrow();
        }
      }
    }
  });

  it('preserves the source-defined GAD-7 totals and screening-only interpretation boundaries', () => {
    const fields = ['feeling_nervous', 'cannot_control_worrying', 'worrying_too_much', 'trouble_relaxing',
      'restlessness', 'easily_annoyed', 'feeling_afraid'] as const;
    const responseForScore = ['not_at_all', 'several_days', 'more_than_half_the_days', 'nearly_every_day'] as const;
    for (const [points, response] of responseForScore.entries()) {
      const inputs = Object.fromEntries(fields.map((field) => [field, response]));
      const result = run('gad7', inputs);
      expect(resultValue(result, 'gad7_score')).toBe(points * 7);
      expect(result.interpretation?.label.toLowerCase()).not.toMatch(/treat|prescribe|start medication/);
    }
    const spec = loadSpec('gad7');
    expect(spec.interpretationBands?.map((band) => band.when)).toEqual(['>=15', '>=10', '>=5', '<5']);
    expect(spec.whenNotToUse).toContain('positive screen requires diagnostic assessment');
  });

  it('pins the Subbe five-parameter MEWS variant and its score-5 risk threshold', () => {
    const normal = {
      systolic_bp_category: 'bp_101_199', heart_rate_category: 'hr_51_100',
      respiratory_rate_category: 'rr_9_14', temperature_category: 'temp_35_384c', avpu: 'alert',
    };
    const score4 = run('mews', { ...normal, systolic_bp_category: 'bp_71_80', heart_rate_category: 'hr_41_50', respiratory_rate_category: 'rr_15_20' });
    const score5 = run('mews', { ...normal, systolic_bp_category: 'bp_le_70', heart_rate_category: 'hr_le_40' });
    const maximum = run('mews', {
      systolic_bp_category: 'bp_le_70', heart_rate_category: 'hr_ge_130',
      respiratory_rate_category: 'rr_ge_30', temperature_category: 'temp_lt_35c', avpu: 'unresponsive',
    });
    expect(resultValue(score4, 'mews_score')).toBe(4);
    expect(score4.interpretations[0]?.code).toBe('mews_band_2');
    expect(resultValue(score5, 'mews_score')).toBe(5);
    expect(score5.interpretations[0]?.code).toBe('mews_band_1');
    expect(resultValue(maximum, 'mews_score')).toBe(14);
    expect(loadSpec('mews').whenNotToUse).toContain('exact Subbe bands');
  });

  it('keeps Brighton PEWS modifiers independent and removes unsupported universal response bands', () => {
    const baseline = { behavior: 'playing_appropriate', cardiovascular: 'pink', respiratory: 'normal', nebulizers: false, vomiting: false };
    expect(resultValue(run('pews', baseline), 'pews_score')).toBe(0);
    expect(resultValue(run('pews', { ...baseline, nebulizers: true }), 'pews_score')).toBe(2);
    expect(resultValue(run('pews', { ...baseline, vomiting: true }), 'pews_score')).toBe(2);
    const maximum = run('pews', { behavior: 'lethargic', cardiovascular: 'gray_mottled', respiratory: 'severe_distress', nebulizers: true, vomiting: true });
    expect(resultValue(maximum, 'pews_score')).toBe(13);
    expect(maximum.interpretations).toEqual([]);
    expect(loadSpec('pews').interpretationBands).toBeUndefined();
    expect(loadSpec('pews').whenNotToUse).toContain('2023 NHS England National PEWS is a different');
  });

  it('uses qSOFA only as the adult suspected-infection prognostic prompt defined by Sepsis-3', () => {
    expect(run('qsofa', { respiratory_rate: 21, systolic_bp: 101, altered_mental_status: false }).results[0]?.value).toBe(0);
    expect(run('qsofa', { respiratory_rate: 22, systolic_bp: 101, altered_mental_status: false }).results[0]?.value).toBe(1);
    expect(run('qsofa', { respiratory_rate: 21, systolic_bp: 100, altered_mental_status: false }).results[0]?.value).toBe(1);
    const positive = run('qsofa', { respiratory_rate: 22, systolic_bp: 100, altered_mental_status: false });
    expect(positive.results[0]?.value).toBe(2);
    expect(positive.interpretation?.label).toContain('not a sepsis diagnosis');
    expect(loadSpec('qsofa').whenNotToUse).toContain('NEWS, NEWS2, MEWS, or SIRS over qSOFA');
  });

  it('pins every modified INR Child-Pugh class boundary without individualized prognosis', () => {
    const base = { bilirubin_category: 'low', albumin_category: 'high', inr_category: 'low', ascites: 'none', encephalopathy: 'none' };
    const rows = [
      [{ ...base }, 5, 'A'],
      [{ ...base, bilirubin_category: 'moderate' }, 6, 'A'],
      [{ ...base, bilirubin_category: 'moderate', albumin_category: 'moderate' }, 7, 'B'],
      [{ ...base, bilirubin_category: 'moderate', albumin_category: 'moderate', inr_category: 'moderate', ascites: 'mild' }, 9, 'B'],
      [{ ...base, bilirubin_category: 'moderate', albumin_category: 'moderate', inr_category: 'moderate', ascites: 'mild', encephalopathy: 'mild' }, 10, 'C'],
      [{ bilirubin_category: 'high', albumin_category: 'low', inr_category: 'high', ascites: 'moderate', encephalopathy: 'severe' }, 15, 'C'],
    ] as const;
    for (const [inputs, score, expectedClass] of rows) {
      const values = Object.fromEntries(run('child_pugh', inputs).results.map(({ name, value }) => [name, value]));
      expect(values).toMatchObject({ score, class: expectedClass });
    }
    expect(loadSpec('child_pugh').whenNotToUse).toContain('not individualized survival');
  });

  it('uses the AHRQ Morse boundaries at 25 and above 45 without turning a band into a treatment rule', () => {
    const base = {
      history_of_falling: 'no', secondary_diagnosis: 'no', ambulatory_aid: 'bed_rest_nurse_assist',
      iv_heparin_lock: 'no', gait_transferring: 'normal_bedrest_immobile', mental_status: 'oriented_to_own_ability',
    };
    const at25 = run('morse_fall_scale', { ...base, history_of_falling: 'yes' });
    const at45 = run('morse_fall_scale', { ...base, secondary_diagnosis: 'yes', ambulatory_aid: 'furniture' });
    const above45 = run('morse_fall_scale', { ...base, history_of_falling: 'yes', secondary_diagnosis: 'yes', gait_transferring: 'weak' });
    expect(at25.interpretations[0]?.code).toBe('morse_fall_scale_band_2');
    expect(at45.interpretations[0]?.code).toBe('morse_fall_scale_band_2');
    expect(above45.interpretations[0]?.code).toBe('morse_fall_scale_band_1');
    expect(above45.interpretation?.label.toLowerCase()).not.toMatch(/must|initiate|required intervention/);
  });

  it('keeps GCS and NIHSS component barriers out of totals', () => {
    const gcs = run('gcs', {
      assessment_context: 'acute_brain_injury', modifier_context: 'intubation_or_tracheostomy',
      eye_opening: 'spontaneous', verbal_response: 'not_testable_intubation', motor_response: 'obeys_commands',
    });
    expect(gcs.results.map((entry) => entry.name)).not.toContain('gcs_total');

    const nihssInputs = { ...loadAuthoritativeReferenceCases('nihss')[0]?.inputs, modifier_context: 'amputation_or_joint_fusion', left_arm_motor: 'amputation' };
    const nihss = run('nihss', nihssInputs);
    expect(nihss.results.map((entry) => entry.name)).not.toContain('nihss_score');
  });

  it('derives Ranson equality boundaries from raw observations without counting equality', () => {
    const result = run('ranson', ransonEquality());
    const values = Object.fromEntries(result.results.map(({ name, value }) => [name, value]));
    expect(values).toMatchObject({
      admission_subtotal: 0,
      score: 0,
      historical_mortality_band: '~1%',
      assessment_complete: true,
      missing_component_reasons: [],
    });
    expect(values.criterion_provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterion: 'wbc', state: 'not_met', points: 0 }),
      expect.objectContaining({ criterion: 'hematocrit_drop', state: 'not_met', points: 0 }),
      expect.objectContaining({ criterion: 'bun_increase', state: 'not_met', points: 0 }),
      expect.objectContaining({ criterion: 'pao2', state: 'not_met', points: 0 }),
    ]));
  });

  it('keeps Ranson follow-up observations not due at 47 hours and rejects early values', () => {
    const admission = ransonEquality();
    admission.assessment_hours = 47;
    delete admission.followup_observed_at_hours;
    for (const field of RANSON_FOLLOWUP_FIELDS) delete admission[field];

    const result = run('ranson', admission);
    const values = Object.fromEntries(result.results.map(({ name, value }) => [name, value]));
    expect(values).toMatchObject({ admission_subtotal: 0, assessment_complete: false });
    expect(values).not.toHaveProperty('score');
    expect(values).not.toHaveProperty('historical_mortality_band');
    expect((values.criterion_provenance as Array<{ state: string }>).filter(({ state }) => state === 'not_due')).toHaveLength(6);
    expect(() => run('ranson', { ...admission, followup_observed_at_hours: 48 })).toThrow();
    expect(() => run('ranson', { ...admission, hematocrit_followup: 35 })).toThrow();
  });

  it('keeps a missing 48-hour Ranson observation unknown and omits the completed score', () => {
    const inputs = ransonEquality();
    delete inputs.calcium_followup;
    const result = run('ranson', inputs);
    expect(result.scoreComplete).toBe(false);
    expect(result.results.map((entry) => entry.name)).not.toContain('score');
    expect(result.results.find((entry) => entry.name === 'criterion_provenance')?.value)
      .toEqual(expect.arrayContaining([expect.objectContaining({ criterion: 'calcium', state: 'unknown' })]));
  });

  it('preserves Ranson unit equivalence, variant identity, timestamps, and retired-input rejection', () => {
    const canonical = run('ranson', ransonEquality());
    const si = run('ranson', {
      ...ransonEquality(),
      wbc_admission: { value: 16, unit: '10^9/L' },
      glucose_admission: { value: 11.102, unit: 'mmol/L' },
      hematocrit_admission: { value: 0.45, unit: 'L/L' },
      bun_admission: { value: 15 * 0.357, unit: 'mmol/L' },
      hematocrit_followup: { value: 0.35, unit: 'L/L' },
      bun_followup: { value: 20 * 0.357, unit: 'mmol/L' },
      pao2_followup: { value: 60 * 0.133322, unit: 'kPa' },
      fluid_sequestration_followup: { value: 6000, unit: 'mL' },
    });
    expect(si.results).toEqual(canonical.results);

    const gallstone = ransonEquality('gallstone');
    expect(() => run('ranson', { ...gallstone, pao2_followup: 60 })).toThrow();
    expect(() => run('ranson', { ...ransonEquality(), followup_observed_at_hours: 49 })).toThrow();
    expect(() => run('ranson', { ...ransonEquality(), admission_observed_at_hours: -1 })).toThrow();
    expect(() => run('ranson', { ...ransonEquality(), wbc_criterion: 'met' })).toThrow();
    expect(() => run('ranson', { ...ransonEquality(), wbc_admission_duplicate: 16000 })).toThrow();
  });

  it('rejects contradictory GCS and NIHSS modifier combinations', () => {
    expect(() => run('gcs', {
      assessment_context: 'acute_brain_injury',
      modifier_context: 'intubation_or_tracheostomy',
      eye_opening: 'spontaneous', verbal_response: 'oriented', motor_response: 'obeys_commands',
    })).toThrow();

    const nihss = loadAuthoritativeReferenceCases('nihss')[0]?.inputs ?? {};
    expect(() => run('nihss', { ...nihss, modifier_context: 'intubation', dysarthria: 'normal' })).toThrow();
    expect(() => run('nihss', { ...nihss, left_arm_motor: 'amputation' })).toThrow();
    expect(() => run('nihss', { ...nihss, modifier_context: 'amputation_or_joint_fusion' })).toThrow();
  });

  it('preserves simultaneous GCS and NIHSS modifiers without forcing a total', () => {
    const gcs = run('gcs', {
      assessment_context: 'acute_brain_injury', modifier_context: 'multiple_modifiers',
      eye_opening: 'not_testable_ocular_obstruction', verbal_response: 'not_testable_intubation',
      motor_response: 'obeys_commands',
    });
    expect(gcs.scoreComplete).toBe(false);
    expect(gcs.scoreMissingReasons).toHaveLength(2);

    const baseline = loadAuthoritativeReferenceCases('nihss')[0]?.inputs ?? {};
    const nihss = run('nihss', {
      ...baseline, modifier_context: 'multiple_modifiers',
      left_arm_motor: 'amputation', dysarthria: 'intubated',
    });
    expect(nihss.scoreComplete).toBe(false);
    expect(nihss.scoreMissingReasons).toHaveLength(2);

    expect(() => run('gcs', {
      assessment_context: 'acute_brain_injury', modifier_context: 'multiple_modifiers',
      eye_opening: 'spontaneous', verbal_response: 'oriented', motor_response: 'obeys_commands',
    })).toThrow();
    expect(() => run('nihss', { ...baseline, modifier_context: 'multiple_modifiers' })).toThrow();
  });

  it('returns every CHA2DS2-VASc lookup row with structured annual risk outputs', () => {
    const cases = [
      { score: 0, age_group: 'under_65', sex: 'male', chf: false, hypertension: false, stroke_history: false, vascular_disease: false, diabetes: false },
      { score: 1, age_group: 'under_65', sex: 'male', chf: true, hypertension: false, stroke_history: false, vascular_disease: false, diabetes: false },
      { score: 2, age_group: 'under_65', sex: 'male', chf: false, hypertension: false, stroke_history: true, vascular_disease: false, diabetes: false },
      { score: 3, age_group: 'under_65', sex: 'male', chf: true, hypertension: false, stroke_history: true, vascular_disease: false, diabetes: false },
      { score: 4, age_group: 'under_65', sex: 'male', chf: true, hypertension: true, stroke_history: true, vascular_disease: false, diabetes: false },
      { score: 5, age_group: 'under_65', sex: 'male', chf: true, hypertension: true, stroke_history: true, vascular_disease: true, diabetes: false },
      { score: 6, age_group: 'under_65', sex: 'male', chf: true, hypertension: true, stroke_history: true, vascular_disease: true, diabetes: true },
      { score: 7, age_group: 'age_75_plus', sex: 'male', chf: true, hypertension: true, stroke_history: true, vascular_disease: true, diabetes: false },
      { score: 8, age_group: 'age_75_plus', sex: 'male', chf: true, hypertension: true, stroke_history: true, vascular_disease: true, diabetes: true },
      { score: 9, age_group: 'age_75_plus', sex: 'female', chf: true, hypertension: true, stroke_history: true, vascular_disease: true, diabetes: true },
    ] as const;
    const expected = [[0.2, 0.3], [0.6, 0.9], [2.2, 2.9], [3.2, 4.6], [4.8, 6.7], [7.2, 10], [9.7, 13.6], [11.2, 15.7], [10.8, 15.2], [12.2, 17.4]];
    for (const [index, inputs] of cases.entries()) {
      const { score, ...rawInputs } = inputs;
      const result = run('chadsvasc', rawInputs);
      const values = Object.fromEntries(result.results.map(({ name, value }) => [name, value]));
      expect(values).toMatchObject({ score, stroke_risk_percent: expected[index][0], thromboembolism_risk_percent: expected[index][1], risk_time_horizon: 'one_year' });
    }
  });

  it('returns every Child-Pugh class without unsupported survival or management outputs', () => {
    for (const vector of loadAuthoritativeReferenceCases('child_pugh')) {
      const result = run('child_pugh', vector.inputs);
      const names = result.results.map(({ name }) => name);
      for (const unsupported of ['one_year_survival', 'two_year_survival', 'one_year_survival_percent', 'two_year_survival_percent']) {
        expect(names).not.toContain(unsupported);
      }
      expect(result.interpretation?.label).toContain('do not infer individualized prognosis or management');
    }
  });

  it('returns every TIMI lookup row with an explicit horizon and endpoint', () => {
    const fields = ['age_65_or_older', 'cad_risk_factors', 'known_cad', 'asa_use', 'severe_angina', 'ekg_st_changes', 'positive_cardiac_marker'] as const;
    const expectedRisk = [4.7, 4.7, 8.3, 13.2, 19.9, 26.2, 40.9, 40.9];
    for (let score = 0; score <= 7; score += 1) {
      const inputs = Object.fromEntries(fields.map((field, index) => [field, index < score]));
      const result = run('timi', inputs);
      const values = Object.fromEntries(result.results.map(({ name, value }) => [name, value]));
      expect(values).toMatchObject({ score, risk_percent: expectedRisk[score], risk_horizon_days: 14, risk_endpoint: 'death_mi_or_urgent_revascularization' });
    }
  });
});

const RANSON_FOLLOWUP_FIELDS = [
  'hematocrit_followup', 'bun_followup', 'calcium_followup', 'pao2_followup',
  'base_deficit_followup', 'fluid_sequestration_followup',
] as const;

function ransonEquality(variant: 'non_gallstone' | 'gallstone' = 'non_gallstone'): Record<string, unknown> {
  const gallstone = variant === 'gallstone';
  return {
    etiology_variant: variant,
    assessment_hours: 48,
    admission_observed_at_hours: 0,
    followup_observed_at_hours: 48,
    age_years: gallstone ? 70 : 55,
    wbc_admission: gallstone ? 18000 : 16000,
    glucose_admission: gallstone ? 220 : 200,
    ast_admission: 250,
    ldh_admission: gallstone ? 400 : 350,
    hematocrit_admission: 45,
    bun_admission: 15,
    hematocrit_followup: 35,
    bun_followup: gallstone ? 17 : 20,
    calcium_followup: 8,
    ...(gallstone ? {} : { pao2_followup: 60 }),
    base_deficit_followup: gallstone ? 5 : 4,
    fluid_sequestration_followup: gallstone ? 4 : 6,
  };
}
