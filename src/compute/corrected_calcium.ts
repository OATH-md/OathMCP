/**
 * Conventional legacy 0.8-factor albumin adjustment (BMJ 1977).
 *
 * Historical conventional equation:
 *   Corrected Ca = Measured Ca + 0.8 × (4 − albumin)
 * Calcium (mg/dL) and albumin (g/dL) arrive in canonical US units; the result is
 * reported in mg/dL. The runner exposes the canonical value and handles input
 * unit normalization before computation.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function correctedCalcium(inputs: CalculatorInputsById['corrected_calcium']): CalculatorOutputsById['corrected_calcium'] {
  const { calcium, albumin } = inputs;

  const corrected = calcium + 0.8 * (4 - albumin);
  return {
    corrected_calcium: roundHalfEven(corrected, 1),
    clinical_use_supported: false,
  };
}

registerCompute('corrected_calcium', correctedCalcium);
