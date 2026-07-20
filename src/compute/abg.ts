/** Deterministic acid-base findings; narrative interpretation stays host-side. */
import { registerCompute } from '../engine/registry.js';
import { registerOutputCondition } from '../engine/output-availability.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import {
  albuminCorrectedAnionGap,
  deltaRatio,
  deltaRatioApplicable,
  rawAnionGap,
} from './anion-gap-helpers.js';
import { roundHalfEven } from './round.js';

type Inputs = CalculatorInputsById['abg'];
type Outputs = CalculatorOutputsById['abg'];

function resolvedSample(inputs: Inputs): {
  type: Outputs['sample_type'];
  provenance: Outputs['sample_type_provenance'];
} {
  if (inputs.sample_type !== undefined) return { type: inputs.sample_type, provenance: 'explicit' };
  if (inputs.venous_sample !== undefined) {
    return {
      type: inputs.venous_sample ? 'peripheral_venous' : 'arterial',
      provenance: 'deprecated_flag',
    };
  }
  return { type: 'arterial', provenance: 'defaulted_arterial' };
}

function arterialBranch(ph: number, pco2: number, bicarbonate: number): Outputs['acid_base_branch_id'] {
  if (ph < 7.35) {
    if (bicarbonate < 22 && pco2 > 45) return 'mixed_acidemia';
    if (bicarbonate < 22) return 'metabolic_acidemia';
    if (pco2 > 45) return 'respiratory_acidemia';
    return 'indeterminate_arterial_pattern';
  }
  if (ph > 7.45) {
    if (bicarbonate > 26 && pco2 < 35) return 'mixed_alkalemia';
    if (bicarbonate > 26) return 'metabolic_alkalemia';
    if (pco2 < 35) return 'respiratory_alkalemia';
    return 'indeterminate_arterial_pattern';
  }
  if (pco2 < 35 && bicarbonate < 22) return 'compensated_or_mixed_low_values';
  if (pco2 > 45 && bicarbonate > 26) return 'compensated_or_mixed_high_values';
  if (pco2 >= 35 && pco2 <= 45 && bicarbonate >= 22 && bicarbonate <= 26) {
    return 'within_arterial_reference';
  }
  return 'indeterminate_arterial_pattern';
}

function expectedPco2(branch: Outputs['acid_base_branch_id'], bicarbonate: number): Outputs['expected_paco2_range'] | undefined {
  if (branch === 'metabolic_acidemia') {
    const mean = 1.5 * bicarbonate + 8;
    return { low: roundHalfEven(mean - 2, 1), high: roundHalfEven(mean + 2, 1), mean: roundHalfEven(mean, 1) };
  }
  if (branch === 'metabolic_alkalemia') {
    const mean = 40 + 0.7 * (bicarbonate - 24);
    return { low: roundHalfEven(mean - 2, 1), high: roundHalfEven(mean + 2, 1), mean: roundHalfEven(mean, 1) };
  }
  return undefined;
}

function compensationAvailable(branch: Outputs['acid_base_branch_id']): boolean {
  return branch === 'metabolic_acidemia' || branch === 'metabolic_alkalemia';
}

function abg(inputs: Inputs): Outputs {
  const sample = resolvedSample(inputs);
  const albumin = inputs.albumin ?? 4;
  const gap = rawAnionGap(inputs.sodium, inputs.chloride, inputs.bicarbonate);
  const correctedGap = albuminCorrectedAnionGap(gap, albumin);
  const branch = sample.type === 'arterial'
    ? arterialBranch(inputs.ph, inputs.paco2, inputs.bicarbonate)
    : 'screening_only_venous';
  const expected = sample.type === 'arterial' ? expectedPco2(branch, inputs.bicarbonate) : undefined;
  const compensationBasis: Outputs['compensation_basis'] = sample.type === 'peripheral_venous'
    ? 'venous_pco2_not_interchangeable'
    : branch === 'metabolic_acidemia'
      ? 'winters_metabolic_acidosis'
      : branch === 'metabolic_alkalemia'
        ? 'metabolic_alkalosis_empirical'
        : branch === 'respiratory_acidemia' || branch === 'respiratory_alkalemia'
          ? 'respiratory_compensation_not_evaluated'
          : branch === 'compensated_or_mixed_low_values' || branch === 'compensated_or_mixed_high_values'
            ? 'compensation_indeterminate_or_not_evaluated'
        : 'not_applicable';
  const mixed: string[] = [];
  if (branch === 'mixed_acidemia') mixed.push('low_bicarbonate_plus_high_pco2_acidemia');
  if (branch === 'mixed_alkalemia') mixed.push('high_bicarbonate_plus_low_pco2_alkalemia');
  let compensationStatus: Outputs['compensation_status'] | undefined;
  if (expected !== undefined) {
    compensationStatus = inputs.paco2 < expected.low
      ? 'below_expected_range'
      : inputs.paco2 > expected.high
        ? 'above_expected_range'
        : 'within_expected_range';
    if (branch === 'metabolic_acidemia' && compensationStatus === 'below_expected_range') mixed.push('metabolic_acidemia_plus_respiratory_alkalemia');
    if (branch === 'metabolic_acidemia' && compensationStatus === 'above_expected_range') mixed.push('metabolic_acidemia_plus_respiratory_acidemia');
    if (branch === 'metabolic_alkalemia' && compensationStatus === 'below_expected_range') mixed.push('metabolic_alkalemia_plus_respiratory_alkalemia');
    if (branch === 'metabolic_alkalemia' && compensationStatus === 'above_expected_range') mixed.push('metabolic_alkalemia_plus_respiratory_acidemia');
  }
  const limitations = [
    'reference_intervals_and_clinical_context_still_required',
    'delta_ratio_is_a_pattern_aid_not_a_diagnosis',
  ];
  if (sample.type === 'peripheral_venous') {
    limitations.push('venous_pco2_not_interchangeable_with_arterial_pco2');
  }
  if (branch === 'respiratory_acidemia' || branch === 'respiratory_alkalemia') {
    limitations.push('respiratory_compensation_is_not_evaluated_by_this_tool');
  }
  if (branch === 'compensated_or_mixed_low_values' || branch === 'compensated_or_mixed_high_values') {
    limitations.push('compensation_or_mixed_status_is_indeterminate_and_not_further_evaluated');
  }
  const output: Outputs = {
    sample_type: sample.type,
    sample_type_provenance: sample.provenance,
    acid_base_branch_id: branch,
    compensation_basis: compensationBasis,
    anion_gap: roundHalfEven(gap, 1),
    albumin_corrected_anion_gap: roundHalfEven(correctedGap, 1),
    albumin_provenance: inputs.albumin === undefined ? 'defaulted_4_g_dl' : 'measured',
    mixed_disorder_branch_ids: mixed,
    missing_data_notes: inputs.albumin === undefined ? ['albumin_not_provided_reference_default_used'] : [],
    limitations,
  };
  if (expected !== undefined && compensationStatus !== undefined) {
    output.expected_paco2_range = expected;
    output.compensation_status = compensationStatus;
  }
  if (deltaRatioApplicable(gap, inputs.bicarbonate)) {
    output.delta_ratio = roundHalfEven(deltaRatio(gap, inputs.bicarbonate), 2);
  }
  if (deltaRatioApplicable(correctedGap, inputs.bicarbonate)) {
    output.albumin_corrected_delta_ratio = roundHalfEven(deltaRatio(correctedGap, inputs.bicarbonate), 2);
  }
  return output;
}

registerCompute('abg', abg);
registerOutputCondition('abg', 'compensation_available', ({ inputs }) => {
  if (resolvedSample(inputs).type !== 'arterial') return false;
  return compensationAvailable(arterialBranch(inputs.ph, inputs.paco2, inputs.bicarbonate));
});
registerOutputCondition('abg', 'delta_ratio_available', ({ inputs }) => {
  const gap = rawAnionGap(inputs.sodium, inputs.chloride, inputs.bicarbonate);
  return deltaRatioApplicable(gap, inputs.bicarbonate);
});
registerOutputCondition('abg', 'corrected_delta_ratio_available', ({ inputs }) => {
  const gap = rawAnionGap(inputs.sodium, inputs.chloride, inputs.bicarbonate);
  const correctedGap = albuminCorrectedAnionGap(gap, inputs.albumin ?? 4);
  return deltaRatioApplicable(correctedGap, inputs.bicarbonate);
});
