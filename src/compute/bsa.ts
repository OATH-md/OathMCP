/**
 * BSA — Body Surface Area (Mosteller).
 *
 * Mosteller equation:
 *   BSA(m²) = √[(height_cm × weight_kg) / 3600]
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function bsa(inputs: CalculatorInputsById['bsa']): CalculatorOutputsById['bsa'] {
  const { weight_kg: weight, height_cm: heightCm } = inputs;

  const value = Math.sqrt((heightCm * weight) / 3600);
  return { bsa: roundHalfEven(value, 2) };
}

registerCompute('bsa', bsa);
