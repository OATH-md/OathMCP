/** CDC triple-panel pattern mapping with explicit unknown/not-tested semantics. */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

type Inputs = CalculatorInputsById['hepb'];
type Outputs = CalculatorOutputsById['hepb'];
type Marker = Inputs['hbsag'];

const absent = (value: Marker): boolean => value === 'unknown' || value === 'not_tested';

function replicationContext(hbeag: Marker, antiHbe: Marker): Outputs['replication_marker_context'] {
  if (hbeag === 'positive' && antiHbe === 'positive') return 'both_detected';
  if (hbeag === 'positive') return 'hbeag_detected';
  if (antiHbe === 'positive') return 'anti_hbe_detected';
  if (absent(hbeag) || absent(antiHbe)) return 'not_fully_assessed';
  return 'neither_detected';
}

function hepb(inputs: Inputs): Outputs {
  const { hbsag, anti_hbc: antiHbc, anti_hbs: antiHbs, igm_anti_hbc: igm } = inputs;
  const missing: string[] = [];
  if (absent(hbsag)) missing.push(`hbsag_${hbsag}`);
  if (absent(antiHbc)) missing.push(`total_anti_hbc_${antiHbc}`);
  if (absent(antiHbs)) missing.push(`anti_hbs_${antiHbs}`);
  if (absent(igm)) missing.push(`igm_anti_hbc_${igm}`);
  if (absent(inputs.hbeag)) missing.push(`hbeag_${inputs.hbeag}`);
  if (absent(inputs.anti_hbe)) missing.push(`anti_hbe_${inputs.anti_hbe}`);
  const nextContext: string[] = [];
  const limitations = [
    'pattern_does_not_establish_treatment_or_prognosis',
    'hbe_markers_do_not_independently_establish_infectivity_or_disease_phase',
  ];

  let status: Outputs['status_code'] = 'incomplete_triple_panel';
  let quality: Outputs['pattern_quality'] = 'insufficient';
  const contradictory =
    (igm === 'positive' && antiHbc === 'negative') ||
    (hbsag === 'positive' && antiHbs === 'positive');

  if (contradictory) {
    status = 'atypical_or_contradictory_pattern';
    quality = 'contradictory_or_atypical';
    nextContext.push('repeat_or_confirm_marker_results_and_review_assay_context');
  } else if ([hbsag, antiHbc, antiHbs].some(absent)) {
    nextContext.push('complete_cdc_triple_panel');
  } else if (hbsag === 'positive' && antiHbc === 'positive' && antiHbs === 'negative') {
    if (igm === 'positive') status = 'acute_infection_pattern';
    else if (igm === 'negative') status = 'chronic_infection_pattern';
    else {
      status = 'incomplete_triple_panel';
      nextContext.push('resolve_igm_anti_hbc_when_acute_infection_is_a_concern');
    }
    quality = status === 'incomplete_triple_panel' ? 'insufficient' : 'complete_supported';
  } else if (hbsag === 'negative' && antiHbc === 'positive' && igm === 'positive') {
    status = 'resolving_or_window_pattern';
    quality = 'complete_supported';
  } else if (hbsag === 'negative' && antiHbc === 'positive' && antiHbs === 'positive') {
    status = 'resolved_infection_pattern';
    quality = 'complete_supported';
    nextContext.push('consider_reactivation_risk_context_when_relevant');
  } else if (hbsag === 'negative' && antiHbc === 'negative' && antiHbs === 'positive') {
    status = 'vaccine_immunity_pattern';
    quality = 'complete_supported';
    nextContext.push('confirm_documented_complete_vaccine_series_if_clinically_relevant');
  } else if (hbsag === 'negative' && antiHbc === 'positive' && antiHbs === 'negative') {
    status = 'isolated_core_antibody_pattern';
    quality = 'complete_supported';
    nextContext.push('review_birth_region_risk_history_immune_status_and_hbv_dna_context');
  } else if (hbsag === 'negative' && antiHbc === 'negative' && antiHbs === 'negative') {
    status = 'susceptible_pattern';
    quality = 'complete_supported';
    nextContext.push('review_vaccination_documentation');
  } else {
    status = 'atypical_or_contradictory_pattern';
    quality = 'contradictory_or_atypical';
    nextContext.push('repeat_or_confirm_marker_results_and_review_assay_context');
  }

  if (hbsag === 'positive' && antiHbc === 'negative') {
    nextContext.push('consider_early_infection_transient_post_vaccine_antigen_or_assay_confirmation_context');
  }
  if (inputs.hbeag === 'positive' || inputs.anti_hbe === 'positive') {
    nextContext.push('interpret_hbe_markers_with_hbv_dna_alt_and_longitudinal_context');
  }

  return {
    status_code: status,
    pattern_quality: quality,
    replication_marker_context: replicationContext(inputs.hbeag, inputs.anti_hbe),
    missing_context: missing,
    next_context: nextContext,
    limitations,
  };
}

registerCompute('hepb', hepb);
