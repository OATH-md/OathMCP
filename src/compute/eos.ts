/** Kaiser Permanente neonatal EOS models with an explicit 2017/2024 choice. */
import { EOS_KAISER_MODELS } from '../clinical-data/index.js';
import { registerOutputCondition } from '../engine/output-availability.js';
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

type EosInputs = CalculatorInputsById['eos'];
type EosOutputs = CalculatorOutputsById['eos'];

function logit(probability: number): number {
  return Math.log(probability / (1 - probability));
}

function originalIntercept(baselineIncidence: EosInputs['baseline_incidence']): number {
  const exact = EOS_KAISER_MODELS.categories[`original_intercept_${baselineIncidence.replace('.', '_')}`];
  if (exact === undefined) throw new Error(`No operator EOS intercept for incidence ${baselineIncidence}.`);
  return exact;
}

function updatedIntercept(baselineIncidence: EosInputs['baseline_incidence']): number {
  const coefficient = EOS_KAISER_MODELS.coefficients;
  if (baselineIncidence === '0.3') return coefficient.updated_reference_intercept!;
  const selected = Number(baselineIncidence) / 1000;
  const reference = 0.3 / 1000;
  return coefficient.updated_reference_intercept! + logit(selected) - logit(reference);
}

export function eosRecommendation(
  modelVersion: EosInputs['model_version'],
  clinicalAppearance: EosInputs['clinical_appearance'],
  compositeRiskPer1000: number,
): Pick<EosOutputs, 'clinical_recommendation' | 'vitals_recommendation'> {
  if (modelVersion === 'updated_2024_universal_gbs') {
    if (clinicalAppearance === 'clinical_illness') {
      return { clinical_recommendation: 'Treat empirically with antibiotics', vitals_recommendation: 'Vitals in NICU' };
    }
    if (compositeRiskPer1000 < 1) {
      return { clinical_recommendation: 'No additional care', vitals_recommendation: 'Routine vitals' };
    }
    if (compositeRiskPer1000 < 3) {
      const hours = clinicalAppearance === 'well_appearing' ? '24' : '16';
      return { clinical_recommendation: `Blood culture and vitals every 4 hours for ${hours} hours`, vitals_recommendation: `Vitals every 4 hours for ${hours} hours` };
    }
    return { clinical_recommendation: 'Treat empirically with antibiotics', vitals_recommendation: 'Vitals in NICU' };
  }

  const posteriorProbability = compositeRiskPer1000 / 1000;
  if (clinicalAppearance === 'clinical_illness' && posteriorProbability < 0.003) {
    return { clinical_recommendation: 'Consider starting empiric antibiotics', vitals_recommendation: 'Vitals per NICU' };
  }
  if (posteriorProbability < 0.001) {
    return { clinical_recommendation: 'No culture, no antibiotics', vitals_recommendation: 'Routine vitals' };
  }
  if (posteriorProbability < 0.003) {
    return { clinical_recommendation: 'Obtain blood culture, no empiric antibiotics', vitals_recommendation: 'Vitals every 4 hours for 24 hours' };
  }
  return { clinical_recommendation: 'Empiric antibiotics', vitals_recommendation: 'Vitals in NICU' };
}

export function eosBirthVitalsRecommendation(
  riskAtBirthPer1000: number,
): 'Routine vitals' | 'Vitals every 4 hours for 16 hours' {
  return riskAtBirthPer1000 < 1 ? 'Routine vitals' : 'Vitals every 4 hours for 16 hours';
}

function eos(inputs: EosInputs): EosOutputs {
  const updated = inputs.model_version === 'updated_2024_universal_gbs';
  const coefficient = EOS_KAISER_MODELS.coefficients;
  const prefix = updated ? 'updated' : 'original';
  const temperatureFahrenheit = (inputs.temperature * 9) / 5 + 32;
  const antibiotic1 = inputs.antibiotic_status === 'gbs_specific_ge_2h_or_any_2_to_4h' ? 1 : 0;
  const antibiotic2 = inputs.antibiotic_status === 'broad_spectrum_ge_4h' ? 1 : 0;
  const gbsPositive = inputs.gbs_status === 'positive' ? 1 : 0;
  const gbsUnknown = inputs.gbs_status === 'unknown' ? 1 : 0;

  const betaX =
    (updated ? updatedIntercept(inputs.baseline_incidence) : originalIntercept(inputs.baseline_incidence)) +
    coefficient[`${prefix}_temperature_f`]! * temperatureFahrenheit +
    coefficient[`${prefix}_gestational_age`]! * inputs.gestational_age +
    coefficient[`${prefix}_gestational_age_squared`]! * inputs.gestational_age ** 2 +
    coefficient[`${prefix}_rom_transform`]! * (inputs.rom_hours + 0.05) ** 0.2 +
    coefficient[`${prefix}_antibiotic_1`]! * antibiotic1 +
    coefficient[`${prefix}_antibiotic_2`]! * antibiotic2 +
    coefficient[`${prefix}_gbs_positive`]! * gbsPositive +
    coefficient[`${prefix}_gbs_unknown`]! * gbsUnknown;

  const riskAtBirth = 1 / (1 + Math.exp(-betaX));
  const likelihoodRatio = EOS_KAISER_MODELS.categories[`${prefix}_lr_${inputs.clinical_appearance}`]!;
  const posteriorOdds = (riskAtBirth / (1 - riskAtBirth)) * likelihoodRatio;
  const compositeRisk = posteriorOdds / (1 + posteriorOdds);
  const riskAtBirthPer1000 = riskAtBirth * 1000;
  const compositeRiskPer1000 = compositeRisk * 1000;

  return {
    risk_at_birth_per_1000: roundHalfEven(riskAtBirthPer1000, 3),
    composite_risk_per_1000: roundHalfEven(compositeRiskPer1000, 3),
    ...(updated ? { birth_vitals_recommendation: eosBirthVitalsRecommendation(riskAtBirthPer1000) } : {}),
    ...eosRecommendation(inputs.model_version, inputs.clinical_appearance, compositeRiskPer1000),
  };
}

registerCompute('eos', eos);
registerOutputCondition('eos', 'updated_birth_vitals', ({ inputs }) =>
  inputs.model_version === 'updated_2024_universal_gbs');
