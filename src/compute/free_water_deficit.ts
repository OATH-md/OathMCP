/**
 * Free Water Deficit in Hypernatremia.
 *
 * Equation:
 *   FWD(L) = %TBW × weight_kg × ((current_Na / ideal_Na) − 1)
 * with %TBW by patient category:
 *   Adult Male 0.6, Adult Female 0.5, Elderly Male 0.5, Elderly Female 0.45.
 * The spec requires current sodium to exceed ideal sodium for hypernatremia;
 * the engine enforces that constraint before computation.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

const TBW_PERCENTAGE: Record<string, number> = {
  adult_male: 0.6,
  adult_female: 0.5,
  elderly_male: 0.5,
  elderly_female: 0.45,
};

function freeWaterDeficit(inputs: CalculatorInputsById['free_water_deficit']): CalculatorOutputsById['free_water_deficit'] {
  const {
    weight_kg: weight,
    current_sodium: currentSodium,
    ideal_sodium: idealSodium,
    patient_category: patientCategory,
  } = inputs;

  const tbwPercentage = TBW_PERCENTAGE[patientCategory];

  const value = tbwPercentage * weight * (currentSodium / idealSodium - 1);

  return {
    free_water_deficit: roundHalfEven(value, 2),
    tbw_percentage_used: tbwPercentage,
  };
}

registerCompute('free_water_deficit', freeWaterDeficit);
