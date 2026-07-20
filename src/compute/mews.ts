/**
 * Modified Early Warning Score (MEWS) — bedside track-and-trigger score.
 *
 * Sum of five banded observations (systolic BP, heart rate, respiratory rate,
 * temperature, AVPU). Each band's points are declared in `specs/mews.yaml` and
 * summed via the shared scoring helper. Distinct enum values keep repeated point
 * values unambiguous across observation ranges. Risk guidance is declared in
 * `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function mews(inputs: CalculatorInputsById['mews']): CalculatorOutputsById['mews'] {
  return { mews_score: sumDeclaredScore('mews', inputs).total as number };
}

registerCompute('mews', mews);
