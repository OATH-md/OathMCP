/**
 * Glasgow Coma Scale (GCS) — level of consciousness after brain injury.
 *
 * Sum of three component scores (eye opening 1-4, verbal 1-5, motor 1-6).
 * Points are declared in `specs/gcs.yaml` and read via the shared scoring
 * helpers; the component scores are carried alongside the total because they
 * add clinical information beyond the severity band. Severity is declared in
 * the spec's `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { registerOutputCondition } from '../engine/output-availability.js';
import { scoreBreakdown, sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function gcs(inputs: CalculatorInputsById['gcs']): CalculatorOutputsById['gcs'] {
  const total = sumDeclaredScore('gcs', inputs);
  const points = Object.fromEntries(total.components.map((component) => [component.field, component.points]));
  return {
    ...(total.complete ? { gcs_total: total.total } : {}),
    ...(points.eye_opening !== undefined ? { eye_score: points.eye_opening } : {}),
    ...(points.verbal_response !== undefined ? { verbal_score: points.verbal_response } : {}),
    ...(points.motor_response !== undefined ? { motor_score: points.motor_response } : {}),
    assessment_complete: total.complete,
    missing_component_reasons: total.missingReasons,
  };
}

registerCompute('gcs', gcs);

registerOutputCondition('gcs', 'complete_total', ({ inputs }) => sumDeclaredScore('gcs', inputs).complete);
registerOutputCondition('gcs', 'eye_testable', ({ inputs }) =>
  scoreBreakdown('gcs', inputs).components.find(({ field }) => field === 'eye_opening')?.testable === true,
);
registerOutputCondition('gcs', 'verbal_testable', ({ inputs }) =>
  scoreBreakdown('gcs', inputs).components.find(({ field }) => field === 'verbal_response')?.testable === true,
);
registerOutputCondition('gcs', 'motor_testable', ({ inputs }) =>
  scoreBreakdown('gcs', inputs).components.find(({ field }) => field === 'motor_response')?.testable === true,
);
