/**
 * Carboplatin Dose (Calvert).
 *
 * Dose (mg) = target_auc × (absolute kidney function used + 25).
 * Indexed eGFR is converted using patient BSA / 1.73. A 125 mL/min cap is
 * applied only when the caller explicitly selects the NCI/CTEP estimated-GFR policy.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function carboplatinAuc(inputs: CalculatorInputsById['carboplatin_auc']): CalculatorOutputsById['carboplatin_auc'] {
  const {
    target_auc: targetAuc,
    gfr: kidneyFunction,
    kidney_function_method: method,
    kidney_function_indexing: indexing,
    patient_bsa: patientBsa,
    cap_policy: capPolicy,
    rounding_policy: roundingPolicy,
  } = inputs;

  const kidneyFunctionAbsolute = indexing === 'indexed_ml_min_1_73m2'
    ? kidneyFunction * (patientBsa as number) / 1.73
    : kidneyFunction;
  const gfrWasCapped = method !== 'measured_gfr'
    && capPolicy === 'nci_ctep_estimated_125'
    && kidneyFunctionAbsolute > 125;
  const kidneyFunctionUsed = gfrWasCapped ? 125 : kidneyFunctionAbsolute;

  const dose = targetAuc * (kidneyFunctionUsed + 25);

  return {
    dose: roundHalfEven(dose, 0),
    kidney_function_absolute: roundHalfEven(kidneyFunctionAbsolute, 2),
    kidney_function_used: roundHalfEven(kidneyFunctionUsed, 2),
    gfr_used: roundHalfEven(kidneyFunctionUsed, 2),
    indexed_conversion_applied: indexing === 'indexed_ml_min_1_73m2',
    gfr_was_capped: gfrWasCapped,
    cap_policy_applied: capPolicy,
    rounding_policy_applied: roundingPolicy,
  };
}

registerCompute('carboplatin_auc', carboplatinAuc);
