/**
 * Morse Fall Scale (MFS) — likelihood of a hospitalized patient falling.
 *
 * Sum of six declared component point values (history of falling, secondary
 * diagnosis, ambulatory aid, IV/heparin lock, gait/transferring, mental status).
 * Points are declared in `specs/morse_fall_scale.yaml` and summed via the shared
 * scoring helper; risk strata are declared in `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function morseFallScale(inputs: CalculatorInputsById['morse_fall_scale']): CalculatorOutputsById['morse_fall_scale'] {
  return { mfs_score: sumDeclaredScore('morse_fall_scale', inputs).total as number };
}

registerCompute('morse_fall_scale', morseFallScale);
