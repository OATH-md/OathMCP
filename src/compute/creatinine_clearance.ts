/**
 * Creatinine clearance — Cockcroft-Gault with an explicitly caller-selected
 * body weight.
 *
 * Cockcroft-Gault equation:
 *   CrCl = ((140 − age) × weight) / (72 × Scr) × 0.85 (if female)
 * Creatinine arrives in canonical mg/dL. Weight selection is intentionally not
 * inferred because drug labels and protocols differ on the required scalar.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function cockcroftGault(
  age: number,
  weight: number,
  creatinine: number,
  isFemale: boolean,
): number {
  let crcl = ((140 - age) * weight) / (72 * creatinine);
  if (isFemale) crcl *= 0.85;
  return roundHalfEven(crcl, 1);
}

function creatinineClearance(inputs: CalculatorInputsById['creatinine_clearance']): CalculatorOutputsById['creatinine_clearance'] {
  const { age, weight_kg: weight, creatinine } = inputs;
  const isFemale = inputs.sex === 'female';
  return {
    creatinine_clearance: cockcroftGault(age, weight, creatinine, isFemale),
  };
}

registerCompute('creatinine_clearance', creatinineClearance);
