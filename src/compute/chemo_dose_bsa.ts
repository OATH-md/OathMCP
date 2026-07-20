/**
 * Chemotherapy Dose (BSA-based).
 *
 * calculated_dose = dose_per_m2 × bsa_used
 * final_dose      = calculated_dose × (1 − dose_reduction/100) when reduction > 0
 *
 * BSA is capped at 2.0 m² only when `cap_bsa` is explicitly true. The spec's
 * conditional warning surfaces every applied cap.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function chemoDoseBsa(inputs: CalculatorInputsById['chemo_dose_bsa']): CalculatorOutputsById['chemo_dose_bsa'] {
  const {
    dose_per_m2: dosePerM2,
    bsa,
    dose_reduction: doseReduction = 0,
    cap_bsa: capBsa = false,
  } = inputs;

  const bsaWasCapped = capBsa && bsa > 2.0;
  const bsaUsed = bsaWasCapped ? 2.0 : bsa;

  const calculatedDose = dosePerM2 * bsaUsed;
  const finalDose =
    doseReduction > 0 ? calculatedDose * (1 - doseReduction / 100) : calculatedDose;

  return {
    calculated_dose: roundHalfEven(calculatedDose, 1),
    final_dose: roundHalfEven(finalDose, 1),
    bsa_used: roundHalfEven(bsaUsed, 2),
    bsa_was_capped: bsaWasCapped,
    reduction_applied: doseReduction,
  };
}

registerCompute('chemo_dose_bsa', chemoDoseBsa);
