/**
 * CHA₂DS₂-VASc Score — stroke risk in non-valvular atrial fibrillation.
 *
 * Weighted points for age group and sex are declared in `specs/chadsvasc.yaml`
 * and summed via the shared
 * scoring helper) plus the binary risk factors. Note the scoring quirk —
 * `stroke_history` is worth +2 while every other boolean is +1 — so the
 * booleans are summed manually rather than with `countTrue`. The 0-9 risk table
 * (annual stroke / thromboembolism percentages) is an in-compute lookup; risk
 * strata are declared in `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

// Annual stroke / thromboembolism risk by score. Score is bounded 0-9.
const RISK_TABLE: Record<number, Pick<CalculatorOutputsById['chadsvasc'], 'stroke_risk' | 'embolism_risk'>> = {
  0: { stroke_risk: '0.2%', embolism_risk: '0.3%' },
  1: { stroke_risk: '0.6%', embolism_risk: '0.9%' },
  2: { stroke_risk: '2.2%', embolism_risk: '2.9%' },
  3: { stroke_risk: '3.2%', embolism_risk: '4.6%' },
  4: { stroke_risk: '4.8%', embolism_risk: '6.7%' },
  5: { stroke_risk: '7.2%', embolism_risk: '10.0%' },
  6: { stroke_risk: '9.7%', embolism_risk: '13.6%' },
  7: { stroke_risk: '11.2%', embolism_risk: '15.7%' },
  8: { stroke_risk: '10.8%', embolism_risk: '15.2%' },
  9: { stroke_risk: '12.2%', embolism_risk: '17.4%' },
};

function chadsvasc(inputs: CalculatorInputsById['chadsvasc']): CalculatorOutputsById['chadsvasc'] {
  const score = sumDeclaredScore('chadsvasc', inputs).total as number;

  const risks = RISK_TABLE[score];
  return {
    score,
    stroke_risk: risks.stroke_risk,
    embolism_risk: risks.embolism_risk,
    stroke_risk_percent: Number.parseFloat(risks.stroke_risk),
    thromboembolism_risk_percent: Number.parseFloat(risks.embolism_risk),
    risk_time_horizon: 'one_year',
  };
}

registerCompute('chadsvasc', chadsvasc);
