/** OPTN MELD 3.0 medical-urgency score for liver-transplant candidates. */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function meld(inputs: CalculatorInputsById['meld']): CalculatorOutputsById['meld'] {
  const ageAtRegistration = inputs.age_at_registration;
  const sex = inputs.sex;
  const dialysis = inputs.dialysis;

  const creatinine = dialysis
    ? 3
    : Math.min(Math.max(inputs.creatinine, 1), 3);
  const bilirubin = Math.max(inputs.bilirubin, 1);
  const inr = Math.max(inputs.inr, 1);
  const sodium = Math.min(Math.max(inputs.sodium, 125), 137);
  const albumin = Math.min(Math.max(inputs.albumin, 1.5), 3.5);
  const adultFemale = ageAtRegistration >= 18 && sex === 'female' ? 1 : 0;
  const baseConstant = ageAtRegistration >= 18 ? 6 : 7.33;

  const score =
    1.33 * adultFemale +
    4.56 * Math.log(bilirubin) +
    0.82 * (137 - sodium) -
    0.24 * (137 - sodium) * Math.log(bilirubin) +
    9.09 * Math.log(inr) +
    11.14 * Math.log(creatinine) +
    1.85 * (3.5 - albumin) -
    1.83 * (3.5 - albumin) * Math.log(creatinine) +
    baseConstant;

  // The engine owns the declared public 6-40 output clamp and emits its trace.
  return { meld: roundHalfEven(score) };
}

registerCompute('meld', meld);
