/**
 * qSOFA — Quick Sequential Organ Failure Assessment.
 *
 * One point each for respiratory rate >= 22/min, systolic BP <= 100 mmHg, and
 * altered mental status. Risk strata are declared in `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function qsofa(inputs: CalculatorInputsById['qsofa']): CalculatorOutputsById['qsofa'] {
  const score = sumDeclaredScore('qsofa', inputs).total as number;
  return { score };
}

registerCompute('qsofa', qsofa);
