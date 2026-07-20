/**
 * IBW — Ideal Body Weight (Devine).
 *
 * Devine equation:
 *   height_inches = height_cm / 2.54
 *   Male:   IBW = 50   + 2.3 × (height_inches − 60)
 *   Female: IBW = 45.5 + 2.3 × (height_inches − 60)
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function ibw(inputs: CalculatorInputsById['ibw']): CalculatorOutputsById['ibw'] {
  const { height_cm: heightCm, sex } = inputs;

  const heightInches = heightCm / 2.54;
  const base = sex === 'male' ? 50 : 45.5;
  const value = base + 2.3 * (heightInches - 60);
  return { ibw: roundHalfEven(value, 1) };
}

registerCompute('ibw', ibw);
