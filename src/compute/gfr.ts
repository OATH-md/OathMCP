/**
 * GFR (eGFR) — 2021 race-free CKD-EPI creatinine equation.
 *
 * 2021 CKD-EPI equation:
 *   eGFR = 142 × (Scr/A)^B × 0.9938^age × (1.012 if female)
 * with the sex-specific A/B coefficient branches. Creatinine arrives in the
 * canonical unit (mg/dL); the runner handles any SI→US conversion upstream.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function gfr(inputs: CalculatorInputsById['gfr']): CalculatorOutputsById['gfr'] {
  const { creatinine, age, sex } = inputs;

  let a: number;
  let b: number;
  let sexFactor: number;

  if (sex === 'female') {
    a = 0.7;
    b = creatinine <= 0.7 ? -0.241 : -1.2;
    sexFactor = 1.012;
  } else {
    a = 0.9;
    b = creatinine <= 0.9 ? -0.302 : -1.2;
    sexFactor = 1.0;
  }

  const value = 142 * (creatinine / a) ** b * 0.9938 ** age * sexFactor;
  return { gfr: roundHalfEven(value, 2) };
}

registerCompute('gfr', gfr);
