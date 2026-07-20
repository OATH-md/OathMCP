/**
 * BMI — Body Mass Index.
 *
 * Equation:
 *   BMI = weight(kg) / height(m)²   with height(m) = height_cm / 100
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function bmi(inputs: CalculatorInputsById['bmi']): CalculatorOutputsById['bmi'] {
  const { weight_kg: weight, height_cm: heightCm } = inputs;

  const heightM = heightCm / 100;
  const value = weight / heightM ** 2;
  return { bmi: roundHalfEven(value, 2) };
}

registerCompute('bmi', bmi);
