import { describe, expect, it } from 'vitest';
import { InputError, evaluateBands, loadSpec, run } from '../../src/engine/index.js';
import { EOS_KAISER_MODELS } from '../../src/clinical-data/index.js';
import { eosBirthVitalsRecommendation, eosRecommendation } from '../../src/compute/eos.js';

function value(id: string, inputs: Record<string, unknown>, output: string): unknown {
  return run(id, inputs).results.find((entry) => entry.name === output)?.value;
}

describe('policy and versioned clinical models', () => {
  it('reproduces the updated Kaiser workbook scenario with an explicit model choice', () => {
    const result = run('eos', {
      model_version: 'updated_2024_universal_gbs',
      baseline_incidence: '0.3',
      temperature: (99 - 32) * 5 / 9,
      rom_hours: 16,
      gestational_age: 40 + 3 / 7,
      antibiotic_status: 'gbs_specific_ge_2h_or_any_2_to_4h',
      gbs_status: 'negative',
      clinical_appearance: 'well_appearing',
    });
    expect(result.results.map(({ name, value: output }) => [name, output])).toEqual([
      ['risk_at_birth_per_1000', 0.033],
      ['composite_risk_per_1000', 0.012],
      ['clinical_recommendation', 'No additional care'],
      ['birth_vitals_recommendation', 'Routine vitals'],
      ['vitals_recommendation', 'Routine vitals'],
    ]);
    expect(result.clinicalModel).toMatchObject({
      modelVersion: 'explicit_2017_original_or_2024_update',
      dataSnapshot: 'eos.kaiser_models_2017_2024',
      stale: false,
    });
  });

  it('preserves the updated EOS at-birth monitoring signal separately from post-exam care', () => {
    const result = run('eos', {
      model_version: 'updated_2024_universal_gbs', baseline_incidence: '0.3',
      temperature: 38.3, rom_hours: 18, gestational_age: 39,
      antibiotic_status: 'none', gbs_status: 'negative', clinical_appearance: 'well_appearing',
    });
    expect(result.results.map(({ name, value: output }) => [name, output])).toEqual([
      ['risk_at_birth_per_1000', 1.317],
      ['composite_risk_per_1000', 0.474],
      ['clinical_recommendation', 'No additional care'],
      ['birth_vitals_recommendation', 'Vitals every 4 hours for 16 hours'],
      ['vitals_recommendation', 'Routine vitals'],
    ]);
    expect(eosBirthVitalsRecommendation(0.999)).toBe('Routine vitals');
    expect(eosBirthVitalsRecommendation(1)).toBe('Vitals every 4 hours for 16 hours');
  });

  it('covers updated EOS appearance precedence and both recommendation thresholds', () => {
    expect(eosRecommendation('updated_2024_universal_gbs', 'clinical_illness', 0.01)).toEqual({
      clinical_recommendation: 'Treat empirically with antibiotics', vitals_recommendation: 'Vitals in NICU',
    });
    for (const appearance of ['well_appearing', 'equivocal'] as const) {
      expect(eosRecommendation('updated_2024_universal_gbs', appearance, 0.999).clinical_recommendation).toBe('No additional care');
      expect(eosRecommendation('updated_2024_universal_gbs', appearance, 3).clinical_recommendation).toBe('Treat empirically with antibiotics');
    }
    expect(eosRecommendation('updated_2024_universal_gbs', 'well_appearing', 1)).toEqual({
      clinical_recommendation: 'Blood culture and vitals every 4 hours for 24 hours',
      vitals_recommendation: 'Vitals every 4 hours for 24 hours',
    });
    expect(eosRecommendation('updated_2024_universal_gbs', 'equivocal', 1)).toEqual({
      clinical_recommendation: 'Blood culture and vitals every 4 hours for 16 hours',
      vitals_recommendation: 'Vitals every 4 hours for 16 hours',
    });
  });

  it('covers original EOS thresholds and makes the selected model transition observable', () => {
    expect(eosRecommendation('original_2017_nonuniversal_gbs', 'well_appearing', 0.999).clinical_recommendation)
      .toBe('No culture, no antibiotics');
    expect(eosRecommendation('original_2017_nonuniversal_gbs', 'well_appearing', 1).clinical_recommendation)
      .toBe('Obtain blood culture, no empiric antibiotics');
    expect(eosRecommendation('original_2017_nonuniversal_gbs', 'equivocal', 3).clinical_recommendation)
      .toBe('Empiric antibiotics');
    expect(eosRecommendation('original_2017_nonuniversal_gbs', 'clinical_illness', 0.5).clinical_recommendation)
      .toBe('Consider starting empiric antibiotics');
    const common = {
      baseline_incidence: '0.3', temperature: 38, rom_hours: 12, gestational_age: 39,
      antibiotic_status: 'none', gbs_status: 'negative', clinical_appearance: 'well_appearing',
    };
    expect(value('eos', { ...common, model_version: 'updated_2024_universal_gbs' }, 'risk_at_birth_per_1000'))
      .not.toBe(value('eos', { ...common, model_version: 'original_2017_nonuniversal_gbs' }, 'risk_at_birth_per_1000'));
  });

  it('accepts the official EOS incidence range and rejects gestational age below 35 weeks', () => {
    const common = {
      model_version: 'updated_2024_universal_gbs', temperature: 37, rom_hours: 8,
      gestational_age: 39, antibiotic_status: 'none', gbs_status: 'negative',
      clinical_appearance: 'well_appearing',
    };
    expect(() => run('eos', { ...common, baseline_incidence: '0.1' })).not.toThrow();
    expect(() => run('eos', { ...common, baseline_incidence: '4' })).not.toThrow();
    expect(() => run('eos', { ...common, baseline_incidence: '0.3', gestational_age: 34.99 })).toThrow(/outside physiological limits/);
    expect(Object.fromEntries(Object.entries(EOS_KAISER_MODELS.categories)
      .filter(([key]) => key.startsWith('original_intercept_')))).toEqual({
      original_intercept_0_1: 38.952265,
      original_intercept_0_2: 39.646367,
      original_intercept_0_3: 40.0528,
      original_intercept_0_4: 40.3415,
      original_intercept_0_5: 40.5656,
      original_intercept_0_6: 40.7489,
      original_intercept_0_7: 40.903919,
      original_intercept_0_8: 41.0384,
      original_intercept_0_9: 41.1571,
      original_intercept_1: 41.263432,
      original_intercept_2: 41.965852,
      original_intercept_4: 42.676976,
    });
  });

  it('keeps GRACE score and mortality risk as distinct outputs', () => {
    const result = run('grace', {
      age: 65, heart_rate: 80, systolic_bp: 120, creatinine: 1.2,
      killip_class: 'ii', cardiac_arrest: false,
      st_segment_deviation: true, elevated_cardiac_enzymes: true,
    });
    expect(result.results.find((entry) => entry.name === 'score')?.value).toBe(137);
    expect(result.results.find((entry) => entry.name === 'mortality_risk')?.value).toBe(14);
    expect(result.clinicalModel.dataSnapshot).toBe('grace_fox_nomogram_2014-01-30');
  });

  it('pins every GRACE Killip increment and NICE mortality boundary', () => {
    const common = {
      age: 35, heart_rate: 70, systolic_bp: 200, creatinine: 0.2,
      cardiac_arrest: false, st_segment_deviation: false, elevated_cardiac_enzymes: false,
    };
    expect(['i', 'ii', 'iii', 'iv'].map((killip_class) =>
      value('grace', { ...common, killip_class }, 'score'))).toEqual([1, 16, 30, 45]);
    const bands = loadSpec('grace').outputs.mortality_risk.interpretationBands!;
    expect([1.5, 1.5001, 3, 3.0001, 6, 6.0001, 9, 9.0001].map((risk) =>
      evaluateBands(bands, risk, {})?.label)).toEqual([
      'Lowest risk', 'Low risk', 'Low risk', 'Intermediate risk',
      'Intermediate risk', 'High risk', 'High risk', 'Highest risk',
    ]);
  });

  it('uses the current OPTN reference year and refuses patient-like donor aliases', () => {
    const inputs = {
      donor_age_years: 40, donor_height_cm: 170, donor_weight_kg: 80,
      donor_hypertension: false, donor_diabetes: false, cause_of_death_cva: false,
      donor_creatinine: 1, donation_after_circulatory_death: false,
    };
    expect(value('kdpi', inputs, 'kdpi')).toBe(14);
    expect(value('kdpi', inputs, 'reference_population_year')).toBe(2025);
    for (const [canonical, unsafe] of [
      ['donor_age_years', 'age'], ['donor_height_cm', 'height_cm'], ['donor_weight_kg', 'weight_kg'],
      ['donor_hypertension', 'hypertension'], ['donor_diabetes', 'diabetes'], ['donor_creatinine', 'creatinine'],
    ] as const) {
      expect(() => run('kdpi', { ...inputs, [canonical]: undefined, [unsafe]: inputs[canonical] })).toThrow(InputError);
    }
  });

  it('covers KDPI coefficient branches, cap behavior, and mapping extremes', () => {
    const common = {
      donor_age_years: 40, donor_height_cm: 170, donor_weight_kg: 80,
      donor_hypertension: false, donor_diabetes: false, cause_of_death_cva: false,
      donor_creatinine: 1, donation_after_circulatory_death: false,
    };
    const raw = (inputs: Record<string, unknown>) => value('kdpi', inputs, 'kdri_raw') as number;
    for (const field of ['donor_hypertension', 'donor_diabetes', 'cause_of_death_cva', 'donation_after_circulatory_death'] as const) {
      expect(raw({ ...common, [field]: true })).toBeGreaterThan(raw(common));
    }
    expect([17, 18, 19].map((donor_age_years) => raw({ ...common, donor_age_years })))
      .toEqual([0.8002, 0.8168, 0.8243]);
    expect([49, 50, 51].map((donor_age_years) => raw({ ...common, donor_age_years })))
      .toEqual([1.0863, 1.0964, 1.1139]);
    expect([79, 80, 81].map((donor_weight_kg) => raw({ ...common, donor_weight_kg })))
      .toEqual([1.0067, 1, 1]);
    expect([169, 170, 171].map((donor_height_cm) => raw({ ...common, donor_height_cm })))
      .toEqual([1.0056, 1, 0.9944]);
    expect([1.4, 1.5, 1.6].map((donor_creatinine) => raw({ ...common, donor_creatinine })))
      .toEqual([1.0888, 1.1123, 1.1115]);
    const atCap = run('kdpi', { ...common, donor_creatinine: 8 });
    const aboveCap = run('kdpi', { ...common, donor_creatinine: 9 });
    expect(aboveCap.results).toEqual(atCap.results);
    expect(aboveCap.adjustments.find((entry) => entry.id === 'creatinine_cap_8')).toMatchObject({
      original: 9, effective: 8, applied: true,
    });
    expect(value('kdpi', { ...common, donor_age_years: 0, donor_height_cm: 241.3, donor_weight_kg: 294.8 }, 'kdpi')).toBeGreaterThanOrEqual(0);
    expect(value('kdpi', { ...common, donor_age_years: 99, donor_height_cm: 30, donor_weight_kg: 0.454, donor_creatinine: 8, donor_hypertension: true, donor_diabetes: true, cause_of_death_cva: true, donation_after_circulatory_death: true }, 'kdpi')).toBe(100);
  });

  it('matches the official KDPI guide worked donor before applying the current annual mapping', () => {
    const result = run('kdpi', {
      donor_age_years: 52, donor_height_cm: 183, donor_weight_kg: 81,
      donor_hypertension: true, donor_diabetes: false, cause_of_death_cva: true,
      donor_creatinine: 1.7, donation_after_circulatory_death: true,
    });
    expect(result.results.find((entry) => entry.name === 'kdri_raw')?.value).toBe(1.7124);
    expect(result.results.find((entry) => entry.name === 'kdri_scaled')?.value).toBe(1.175);
    expect(result.results.find((entry) => entry.name === 'kdpi')?.value).toBe(67);
    expect(result.results.find((entry) => entry.name === 'reference_population_year')?.value).toBe(2025);
  });

  it('uses age at registration and never applies the adult sex coefficient to adolescents', () => {
    const common = {
      creatinine: 2, bilirubin: 2, inr: 1.5, sodium: 135, albumin: 3, dialysis: false,
    };
    const adolescentFemale = value('meld', { ...common, age_at_registration: 16, sex: 'female' }, 'meld');
    const adolescentMale = value('meld', { ...common, age_at_registration: 16, sex: 'male' }, 'meld');
    const adultFemale = value('meld', { ...common, age_at_registration: 40, sex: 'female' }, 'meld');
    const adultMale = value('meld', { ...common, age_at_registration: 40, sex: 'male' }, 'meld');
    expect(adolescentFemale).toBe(adolescentMale);
    expect(adultFemale).toBeGreaterThan(adultMale as number);
  });

  it('covers MELD registration-age transition, every clamp, dialysis, and SI parity', () => {
    const labs = { creatinine: 2, bilirubin: 2, inr: 1.5, sodium: 135, albumin: 3, dialysis: false };
    for (const age_at_registration of [12, 17]) {
      expect(value('meld', { ...labs, age_at_registration, sex: 'female' }, 'meld'))
        .toBe(value('meld', { ...labs, age_at_registration, sex: 'male' }, 'meld'));
    }
    expect(value('meld', { ...labs, age_at_registration: 18, sex: 'female' }, 'meld'))
      .toBeGreaterThan(value('meld', { ...labs, age_at_registration: 18, sex: 'male' }, 'meld') as number);
    const clamped = run('meld', {
      creatinine: 0.5, bilirubin: 0.5, inr: 0.5, sodium: 140, albumin: 4,
      age_at_registration: 40, sex: 'male', dialysis: false,
    });
    expect(clamped.adjustments.filter((entry) => entry.applied).map((entry) => entry.id)).toEqual([
      'creatinine_clamp_1_3', 'bilirubin_floor_1', 'inr_floor_1',
      'sodium_clamp_125_137', 'albumin_clamp_1_5_3_5',
    ]);
    const maximum = run('meld', {
      creatinine: 10, bilirubin: 50, inr: 10, sodium: 100, albumin: 1,
      age_at_registration: 40, sex: 'female', dialysis: true,
    });
    expect(value('meld', {
      creatinine: 10, bilirubin: 50, inr: 10, sodium: 100, albumin: 1,
      age_at_registration: 40, sex: 'female', dialysis: true,
    }, 'meld')).toBe(40);
    expect(maximum.adjustments.find((entry) => entry.id === 'meld_score_clamp_6_40')).toMatchObject({ applied: true, effective: 40 });
    expect(value('meld', { ...labs, creatinine: 1, dialysis: true, age_at_registration: 40, sex: 'male' }, 'meld'))
      .toBe(value('meld', { ...labs, creatinine: 3, dialysis: true, age_at_registration: 40, sex: 'male' }, 'meld'));
    const canonical = run('meld', { ...labs, age_at_registration: 40, sex: 'male' });
    const si = run('meld', {
      creatinine: { value: 176.8, unit: 'umol/L' }, bilirubin: { value: 34.2, unit: 'umol/L' },
      inr: 1.5, sodium: 135, albumin: { value: 30, unit: 'g/L' },
      age_at_registration: 40, sex: 'male', dialysis: false,
    });
    expect(si.results).toEqual(canonical.results);
  });
});
