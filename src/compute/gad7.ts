/**
 * GAD-7 — Generalized Anxiety Disorder-7 screening score.
 *
 * Sum of seven 0-3 frequency items. Points are declared in `specs/gad7.yaml`
 * and summed via the shared scoring helper; severity is declared in
 * `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function gad7(inputs: CalculatorInputsById['gad7']): CalculatorOutputsById['gad7'] {
  return { gad7_score: sumDeclaredScore('gad7', inputs).total as number };
}

registerCompute('gad7', gad7);
