/**
 * NIH Stroke Scale (NIHSS) — quantifies stroke severity.
 *
 * Sum of 15 focused neurological items, each scored on its own scale (0-2, 0-3,
 * or 0-4) for a total of 0-42. Points are declared in `specs/nihss.yaml` and
 * summed via the shared scoring helper (no label parsing); stroke-severity
 * strata are declared in `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { registerOutputCondition } from '../engine/output-availability.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function nihss(inputs: CalculatorInputsById['nihss']): CalculatorOutputsById['nihss'] {
  const score = sumDeclaredScore('nihss', inputs);
  return {
    ...(score.complete ? { nihss_score: score.total } : {}),
    assessment_complete: score.complete,
    missing_component_reasons: score.missingReasons,
  };
}

registerCompute('nihss', nihss);
registerOutputCondition('nihss', 'complete_total', ({ inputs }) => sumDeclaredScore('nihss', inputs).complete);
