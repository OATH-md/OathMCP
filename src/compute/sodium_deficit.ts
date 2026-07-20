/**
 * Sodium Deficit in Hyponatremia.
 *
 * Equations:
 *   sodium_deficit = TBW × (desired_Na − current_Na)
 *   TBW (adult men,   age ≥ 18) = 2.447 − 0.09516×age + 0.1074×height_cm + 0.3362×weight_kg
 *   TBW (adult women, age ≥ 18) = −2.097 + 0.1069×height_cm + 0.2466×weight_kg
 * The calculator is adult-only; age, height, and sex are required by the spec.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function sodiumDeficit(inputs: CalculatorInputsById['sodium_deficit']): CalculatorOutputsById['sodium_deficit'] {
  const {
    weight_kg: weight,
    current_sodium: currentSodium,
    desired_sodium: desiredSodium,
    age,
    height_cm: heightCm,
    sex,
  } = inputs;

  const tbw = sex === 'male'
    ? 2.447 - 0.09516 * age + 0.1074 * heightCm + 0.3362 * weight
    : -2.097 + 0.1069 * heightCm + 0.2466 * weight;

  const deficit = tbw * (desiredSodium - currentSodium);

  return {
    total_body_water: roundHalfEven(tbw, 2),
    sodium_deficit: roundHalfEven(deficit, 1),
  };
}

registerCompute('sodium_deficit', sodiumDeficit);
