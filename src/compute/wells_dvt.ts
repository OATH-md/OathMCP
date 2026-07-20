/**
 * Wells' Criteria for DVT — pretest probability of deep vein thrombosis.
 *
 * Nine clinical features each add +1, but `alternative_diagnosis` subtracts 2
 * (the only criterion that is not +1). So the booleans are NOT summed with a
 * plain `countTrue` over all inputs — only the nine +1 criteria go through
 * `countTrue`, then 2 is subtracted when an alternative diagnosis is at least as
 * likely. The score can therefore be negative (minimum -2, maximum 9). The
 * two-level pretest-probability strata are declared in `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

function wellsDvt(inputs: CalculatorInputsById['wells_dvt']): CalculatorOutputsById['wells_dvt'] {
  const score = sumDeclaredScore('wells_dvt', inputs).total as number;

  const risk_category = score >= 2 ? 'likely' : 'unlikely';

  return { score, risk_category };
}

registerCompute('wells_dvt', wellsDvt);
