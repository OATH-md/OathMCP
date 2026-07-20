/**
 * GIR — Glucose Infusion Rate.
 *
 * Equation:
 *   GIR(mg/kg/min) = (dextrose% × infusion_rate mL/hr) / (weight_kg × 6)
 * The factor 6 folds %→g/mL (÷100), hr→min (÷60), g→mg (×1000): (100×60)/1000 = 6.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function gir(inputs: CalculatorInputsById['gir']): CalculatorOutputsById['gir'] {
  const {
    weight_kg: weight,
    dextrose_concentration: dextrose,
    infusion_rate: infusionRate,
  } = inputs;

  const value = (dextrose * infusionRate) / (weight * 6);
  return { gir: roundHalfEven(value, 2) };
}

registerCompute('gir', gir);
