/**
 * APGAR Score — newborn condition at 1 and 5 minutes.
 *
 * Sum of five 0-2 component scores (Appearance, Pulse, Grimace, Activity,
 * Respiratory). Points are declared in `specs/apgar.yaml` and summed via the
 * shared scoring helper; severity strata are declared in `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function apgar(inputs: CalculatorInputsById['apgar']): CalculatorOutputsById['apgar'] {
  return { apgar_score: sumDeclaredScore('apgar', inputs).total as number };
}

registerCompute('apgar', apgar);
