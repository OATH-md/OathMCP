import { registerCompute } from '../engine/registry.js';
import { roundHalfEven } from './round.js';

export interface Inputs {
  readonly age: number;
  readonly ast: number;
  readonly alt: number;
  readonly platelet_count: number;
  readonly assessment_context: 'stable_ambulatory' | 'acutely_ill';
}

export interface Outputs {
  readonly fib4_score: number;
  readonly screen_result:
    | 'not_interpreted_age_under_35'
    | 'screen_negative'
    | 'secondary_assessment_needed';
}

/**
 * Published Sterling FIB-4 equation:
 *   (age × AST) / (platelet count × sqrt(ALT))
 *
 * Inputs arrive in the canonical units declared by the spec. Screening
 * uses the unrounded score; only the public score is rounded.
 */
export function compute(inputs: Inputs): Outputs {
  const rawScore = (inputs.age * inputs.ast) /
    (inputs.platelet_count * Math.sqrt(inputs.alt));

  let screenResult: Outputs['screen_result'];
  if (inputs.age < 35) {
    screenResult = 'not_interpreted_age_under_35';
  } else {
    const screeningCutoff = inputs.age >= 65 ? 2 : 1.3;
    screenResult = rawScore < screeningCutoff
      ? 'screen_negative'
      : 'secondary_assessment_needed';
  }

  return {
    fib4_score: roundHalfEven(rawScore, 2),
    screen_result: screenResult,
  };
}

registerCompute('fib4', compute);
