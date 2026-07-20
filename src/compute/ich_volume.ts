/**
 * ICH Volume — simplified Intracerebral Hemorrhage volume (ABC/2).
 *
 * Equations:
 *   volume = (A × B × slice thickness × slice count) / 2
 *
 * `ellipsoid_shape` is retained as a compatibility input but does not select
 * the unsupported ABC/3 shortcut. The public spec documents when formal
 * planimetry or segmentation is preferable.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function ichVolume(inputs: CalculatorInputsById['ich_volume']): CalculatorOutputsById['ich_volume'] {
  const {
    length_cm: length,
    width_cm: width,
    slice_width_cm: sliceWidth,
    num_slices: numSlices,
  } = inputs;

  const value = (length * width * sliceWidth * numSlices) / 2;
  return { volume_ml: roundHalfEven(value, 1) };
}

registerCompute('ich_volume', ichVolume);
