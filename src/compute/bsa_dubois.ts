/**
 * Body Surface Area — DuBois & DuBois formula.
 *
 * DuBois and DuBois equation:
 *   BSA (m²) = 0.007184 × Height(cm)^0.725 × Weight(kg)^0.425
 * Inputs arrive in canonical units (cm and kg). Interpretation is declared in
 * the spec's `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function bsaDuBois(inputs: CalculatorInputsById['bsa_dubois']): CalculatorOutputsById['bsa_dubois'] {
  const { height_cm: heightCm, weight_kg: weightKg } = inputs;

  const bsa = 0.007184 * heightCm ** 0.725 * weightKg ** 0.425;
  return { bsa: roundHalfEven(bsa, 2) };
}

registerCompute('bsa_dubois', bsaDuBois);
