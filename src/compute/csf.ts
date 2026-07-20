/** Deterministic CSF derivations and pattern-compatible findings. */
import { registerCompute } from '../engine/registry.js';
import { registerOutputCondition } from '../engine/output-availability.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

type Inputs = CalculatorInputsById['csf'];
type Outputs = CalculatorOutputsById['csf'];

const correctionDivisor: Record<Inputs['traumatic_tap_method'], number | undefined> = {
  none: undefined,
  one_wbc_per_500_rbc: 500,
  one_wbc_per_1000_rbc: 1000,
  one_wbc_per_1500_rbc: 1500,
};

function correctedWbc(inputs: Inputs): number {
  const divisor = correctionDivisor[inputs.traumatic_tap_method];
  if (divisor === undefined || inputs.rbc_per_ul === undefined) return inputs.wbc_per_ul;
  return Math.max(inputs.wbc_per_ul - Math.floor(inputs.rbc_per_ul / divisor), 0);
}

function reported(value: 'positive' | 'negative' | 'unknown' | 'not_tested'): boolean {
  return value !== 'not_tested' && value !== 'unknown';
}

function csf(inputs: Inputs): Outputs {
  const wbc = correctedWbc(inputs);
  const ratio = inputs.csf_glucose_mmol_l !== undefined && inputs.serum_glucose_mmol_l !== undefined
    ? roundHalfEven(inputs.csf_glucose_mmol_l / inputs.serum_glucose_mmol_l, 3)
    : undefined;
  const adult = inputs.age_years >= 18;
  const derived: string[] = [];
  const assays: string[] = [];
  const support: string[] = [];
  const differentials: string[] = [];
  const missing: string[] = [];
  const limitations = ['compatible_patterns_are_not_diagnoses'];
  const pleocytosis = adult && wbc > 5;
  const proteinElevated = adult && inputs.protein_mg_dl !== undefined && inputs.protein_mg_dl > 45;

  if (adult) {
    if (pleocytosis) derived.push('adult_reference_pleocytosis_present');
    if (proteinElevated) derived.push('adult_reference_protein_elevated');
  } else {
    limitations.push('age_specific_reference_intervals_required');
  }
  if (inputs.wbc_diff === 'pmn') derived.push('pmn_predominant');
  if (inputs.wbc_diff === 'lymphocyte') derived.push('lymphocyte_predominant');
  if (inputs.wbc_diff === 'mixed') derived.push('mixed_cell_differential');
  if (ratio !== undefined && ratio < 0.4) derived.push('low_csf_serum_glucose_ratio');
  if (inputs.opening_pressure_cm_h2o !== undefined && inputs.opening_pressure_cm_h2o > 25) {
    derived.push('opening_pressure_above_25_cm_h2o');
  }
  if (inputs.rbc_per_ul !== undefined && inputs.rbc_per_ul > 0) derived.push('red_cells_present');

  if (inputs.gram_stain_result === 'positive') assays.push('gram_stain_positive');
  if (inputs.bacterial_culture_result === 'positive') assays.push('bacterial_culture_positive');
  if (inputs.pathogen_pcr_result === 'positive' && !['not_specified', 'other'].includes(inputs.pathogen_pcr_identity ?? 'not_specified')) {
    assays.push(`pathogen_pcr_positive:${inputs.pathogen_pcr_identity}`);
  }
  if (inputs.mycobacterial_result === 'positive' && !['not_specified', 'other'].includes(inputs.mycobacterial_assay ?? 'not_specified')) {
    assays.push(`mycobacterial_assay_positive:${inputs.mycobacterial_assay}`);
  }
  if (inputs.fungal_result === 'positive' && !['not_specified', 'other'].includes(inputs.fungal_assay ?? 'not_specified')) {
    assays.push(`fungal_assay_positive:${inputs.fungal_assay}`);
  }
  const identifiedNeuralAntibody = inputs.neural_antibody_result === 'positive' &&
    !['not_specified', 'other'].includes(inputs.neural_antibody_identity ?? 'not_specified') &&
    inputs.neural_antibody_specimen !== undefined &&
    inputs.neural_antibody_specimen !== 'not_specified';
  if (identifiedNeuralAntibody) {
    assays.push(`neural_antibody_positive:${inputs.neural_antibody_identity}:${inputs.neural_antibody_specimen}`);
  }
  if (inputs.oligoclonal_band_status === 'csf_restricted') assays.push('paired_ocb_csf_restricted');
  if (inputs.oligoclonal_band_status === 'matched_serum_and_csf') assays.push('paired_ocb_matched');

  if (pleocytosis && inputs.wbc_diff === 'pmn' && (ratio !== undefined && ratio < 0.4 || proteinElevated)) {
    support.push('bacterial_meningitis_compatible_pattern');
    differentials.push('bacterial_and_other_neutrophilic_meningitis_processes');
  }
  if (pleocytosis && inputs.wbc_diff === 'lymphocyte' && ratio !== undefined && ratio >= 0.5) {
    support.push('lymphocytic_inflammation_with_preserved_glucose_pattern');
    differentials.push('viral_and_other_lymphocytic_inflammatory_processes');
  }
  if (
    pleocytosis &&
    (inputs.wbc_diff === 'lymphocyte' || inputs.wbc_diff === 'mixed') &&
    ratio !== undefined &&
    ratio < 0.4 &&
    proteinElevated
  ) {
    support.push('chronic_meningitis_compatible_pattern');
    differentials.push('mycobacterial_fungal_and_other_chronic_meningitis_processes');
  }
  if (adult && wbc <= 5 && proteinElevated) {
    support.push('albuminocytologic_dissociation_compatible_pattern');
    differentials.push('multiple_causes_of_albuminocytologic_dissociation');
  }
  if (inputs.oligoclonal_band_status === 'csf_restricted') {
    support.push('csf_restricted_oligoclonal_band_pattern');
    differentials.push('intrathecal_immune_activation_requires_clinical_and_imaging_context');
  }
  if (identifiedNeuralAntibody) {
    support.push('identified_neural_antibody_reported');
    differentials.push('antibody_result_requires_phenotype_assay_and_specimen_correlation');
  }

  let xanthochromia: Outputs['xanthochromia_context'] = 'not_assessed';
  if (inputs.xanthochromia_result !== 'not_tested') {
    if (
      inputs.xanthochromia_result === 'positive' &&
      inputs.xanthochromia_method === 'spectrophotometry' &&
      inputs.hours_from_onset_to_lumbar_puncture !== undefined &&
      inputs.hours_from_onset_to_lumbar_puncture >= 12
    ) {
      xanthochromia = 'supported_spectrophotometry_after_12h';
      support.push('spectrophotometric_xanthochromia_after_12h');
      differentials.push('subarachnoid_blood_requires_imaging_and_specialist_correlation');
    } else if (
      inputs.xanthochromia_result === 'negative' &&
      inputs.xanthochromia_method === 'spectrophotometry' &&
      inputs.hours_from_onset_to_lumbar_puncture !== undefined &&
      inputs.hours_from_onset_to_lumbar_puncture >= 12
    ) {
      xanthochromia = 'negative_spectrophotometry_reported';
    } else {
      xanthochromia = 'result_or_method_or_timing_insufficient';
      limitations.push('unknown_visual_or_early_xanthochromia_does_not_satisfy_nice_spectrophotometry_branch');
    }
  }

  if (inputs.appearance === undefined || inputs.appearance === 'unknown') missing.push('appearance');
  if (inputs.opening_pressure_cm_h2o === undefined) missing.push('opening_pressure');
  if (inputs.rbc_per_ul === undefined) missing.push('rbc_count');
  if (inputs.csf_glucose_mmol_l === undefined) missing.push('csf_glucose');
  if (inputs.serum_glucose_mmol_l === undefined) missing.push('paired_blood_glucose');
  if (inputs.protein_mg_dl === undefined) missing.push('csf_protein');
  if (inputs.symptom_onset_days === undefined) missing.push('symptom_onset_timing');
  if (inputs.imaging_context === 'unknown' || inputs.imaging_context === 'not_done') missing.push('imaging_context');
  if (inputs.immune_status === 'unknown') missing.push('immune_status');
  if (inputs.wbc_diff === 'unknown') missing.push('wbc_differential');
  if (!reported(inputs.gram_stain_result)) missing.push(`gram_stain_${inputs.gram_stain_result}`);
  if (!reported(inputs.bacterial_culture_result)) missing.push(`bacterial_culture_${inputs.bacterial_culture_result}`);
  if (inputs.pathogen_pcr_result === 'positive' && ['not_specified', 'other'].includes(inputs.pathogen_pcr_identity ?? 'not_specified')) missing.push('exact_pathogen_pcr_identity');
  if (inputs.fungal_result === 'positive' && ['not_specified', 'other'].includes(inputs.fungal_assay ?? 'not_specified')) missing.push('exact_fungal_assay_identity');
  if (inputs.mycobacterial_result === 'positive' && ['not_specified', 'other'].includes(inputs.mycobacterial_assay ?? 'not_specified')) missing.push('exact_mycobacterial_assay_identity');
  if (inputs.neural_antibody_result === 'positive' && !identifiedNeuralAntibody) missing.push('exact_neural_antibody_identity_and_specimen');
  if (
    (inputs.xanthochromia_result === 'positive' || inputs.xanthochromia_result === 'negative') &&
    inputs.xanthochromia_method !== 'spectrophotometry'
  ) missing.push('spectrophotometric_xanthochromia_method');
  if (
    (inputs.xanthochromia_result === 'positive' || inputs.xanthochromia_result === 'negative') &&
    inputs.hours_from_onset_to_lumbar_puncture === undefined
  ) missing.push('hours_from_onset_to_lumbar_puncture');
  if (inputs.antimicrobial_pretreatment === 'yes') limitations.push('antimicrobial_pretreatment_can_reduce_test_sensitivity');
  if (inputs.antimicrobial_pretreatment === 'unknown') limitations.push('pretreatment_status_unknown');
  if (inputs.immune_status === 'immunocompromised') limitations.push('immunocompromise_changes_expected_patterns_and_test_performance');
  if (inputs.traumatic_tap_method !== 'none') limitations.push('traumatic_tap_correction_is_a_heuristic_with_sensitivity_specificity_tradeoffs');
  if (inputs.fungal_result === 'positive' && inputs.fungal_assay === 'beta_d_glucan') {
    limitations.push('beta_d_glucan_is_nonspecific_and_does_not_confirm_fungal_meningitis');
  }

  const output: Outputs = {
    corrected_wbc: wbc,
    wbc_correction_method: inputs.traumatic_tap_method,
    derived_values: derived,
    confirmed_assays: assays,
    support_flags: support,
    differential_considerations: differentials,
    xanthochromia_context: xanthochromia,
    missing_context: missing,
    limitations,
  };
  if (ratio !== undefined) output.csf_serum_glucose_ratio = ratio;
  return output;
}

registerCompute('csf', csf);
registerOutputCondition('csf', 'glucose_ratio_available', ({ inputs }) =>
  inputs.csf_glucose_mmol_l !== undefined && inputs.serum_glucose_mmol_l !== undefined);
