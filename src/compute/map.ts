/**
 * MAP — Mean Arterial Pressure.
 *
 * Equation:
 *   MAP = DBP + 1/3 × (SBP − DBP)
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function map(inputs: CalculatorInputsById['map']): CalculatorOutputsById['map'] {
  const { systolic_bp: systolic, diastolic_bp: diastolic } = inputs;

  const value = diastolic + (1 / 3) * (systolic - diastolic);
  return { map: roundHalfEven(value, 2) };
}

registerCompute('map', map);
