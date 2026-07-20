/**
 * PEWS — Pediatric Early Warning Score.
 *
 * Sum of three 0-3 component scores (behavior, cardiovascular, respiratory),
 * whose points are declared in `specs/pews.yaml` and summed via the shared
 * scoring helper, plus two boolean modifiers worth 2 points each (quarter-hourly
 * nebulizers, persistent post-op vomiting). Risk guidance is declared in
 * `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function pews(inputs: CalculatorInputsById['pews']): CalculatorOutputsById['pews'] {
  return { pews_score: sumDeclaredScore('pews', inputs).total as number };
}

registerCompute('pews', pews);
