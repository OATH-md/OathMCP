/**
 * R Factor for liver injury pattern.
 *
 * Equation and classification:
 *   R = (ALT / ALT_ULN) / (ALP / ALP_ULN)   (fallback ALT_ULN 40, ALP_ULN 115)
 *   R ≥ 5       → Hepatocellular
 *   2 < R < 5 → Mixed
 *   R ≤ 2       → Cholestatic
 * Classification uses the unrounded ratio; only the reported `r_factor` is
 * rounded to 2 decimal places. The zero-denominator guard is defensive because
 * the spec requires strictly positive inputs.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function rFactor(inputs: CalculatorInputsById['r_factor']): CalculatorOutputsById['r_factor'] {
  const { alt, alp, alt_uln: altUln, alp_uln: alpUln } = inputs;

  const altRatio = alt / altUln;
  const alpRatio = alp / alpUln;
  const r = alpRatio === 0 ? Infinity : altRatio / alpRatio;

  let injuryType: CalculatorOutputsById['r_factor']['injury_type'];
  if (r >= 5) {
    injuryType = 'Hepatocellular';
  } else if (r > 2) {
    injuryType = 'Mixed';
  } else {
    injuryType = 'Cholestatic';
  }

  return {
    r_factor: Number.isFinite(r) ? roundHalfEven(r, 2) : Infinity,
    injury_type: injuryType,
  };
}

registerCompute('r_factor', rFactor);
