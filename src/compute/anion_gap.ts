/**
 * Anion Gap (with albumin correction and delta ratio).
 *
 * Equations:
 *   AG                 = Na − (Cl + HCO3)
 *   albumin-corrected  = AG + 2.5 × (4 − albumin)
 *   delta gap          = AG − 12
 *   delta ratio        = delta gap / (24 − HCO3), only when HCO3 < 24 and
 *                        the corresponding gap is elevated
 * Sodium/chloride/bicarbonate share the same US and SI units (mEq/L ≡ mmol/L),
 * so only albumin is a converted quantity; it arrives here in canonical g/dL.
 */
import { registerOutputCondition } from '../engine/output-availability.js';
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import {
  albuminCorrectedAnionGap,
  deltaRatio,
  deltaRatioApplicable,
  rawAnionGap,
} from './anion-gap-helpers.js';
import { roundHalfEven } from './round.js';

// Use banker's rounding so the 1-decimal gaps and 2-decimal ratios are
// deterministic at exact half-way boundaries
// (e.g. a delta ratio of 0.625 rounds to 0.62, not 0.63).
const round1 = (v: number) => roundHalfEven(v, 1);
const round2 = (v: number) => roundHalfEven(v, 2);

function anionGap(inputs: CalculatorInputsById['anion_gap']): CalculatorOutputsById['anion_gap'] {
  const { bicarbonate } = inputs;
  const ag = rawAnionGap(inputs.sodium, inputs.chloride, bicarbonate);
  const correctedAg = inputs.albumin === undefined
    ? undefined
    : albuminCorrectedAnionGap(ag, inputs.albumin);
  const deltaAnionGap = ag - 12;
  const correctedDeltaAnionGap = correctedAg === undefined ? undefined : correctedAg - 12;

  // If bicarbonate is 24 or higher there is no acidosis, so the delta ratio is
  // not applicable (the denominator would be non-positive).
  const uncorrectedDeltaRatio = deltaRatioApplicable(ag, bicarbonate)
    ? deltaRatio(ag, bicarbonate)
    : undefined;
  let correctedDeltaRatio: number | undefined;
  if (correctedAg !== undefined && deltaRatioApplicable(correctedAg, bicarbonate)) {
    correctedDeltaRatio = deltaRatio(correctedAg, bicarbonate);
  }

  return {
    anion_gap: round1(ag),
    ...(correctedAg === undefined ? {} : { albumin_corrected_anion_gap: round1(correctedAg) }),
    delta_anion_gap: round1(deltaAnionGap),
    ...(correctedDeltaAnionGap === undefined ? {} : {
      albumin_corrected_delta_anion_gap: round1(correctedDeltaAnionGap),
    }),
    ...(uncorrectedDeltaRatio === undefined ? {} : { delta_ratio: round2(uncorrectedDeltaRatio) }),
    ...(correctedDeltaRatio === undefined ? {} : {
      albumin_corrected_delta_ratio: round2(correctedDeltaRatio),
    }),
  };
}

registerCompute('anion_gap', anionGap);

registerOutputCondition('anion_gap', 'uncorrected_delta_ratio_applicable', ({ inputs }) => {
  const gap = rawAnionGap(inputs.sodium, inputs.chloride, inputs.bicarbonate);
  return deltaRatioApplicable(gap, inputs.bicarbonate);
});

registerOutputCondition('anion_gap', 'corrected_delta_ratio_applicable', ({ inputs }) => {
  if (inputs.albumin === undefined) return false;
  const gap = rawAnionGap(inputs.sodium, inputs.chloride, inputs.bicarbonate);
  return deltaRatioApplicable(albuminCorrectedAnionGap(gap, inputs.albumin), inputs.bicarbonate);
});
