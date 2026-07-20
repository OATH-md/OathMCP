/** Fox 2006 GRACE cumulative admission-to-6-month mortality nomogram. */
import { evaluateLinearTable, evaluateLookupTable, GRACE_2006, tableById } from '../clinical-data/index.js';
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

const agePoints = tableById(GRACE_2006, 'age_points');
const heartRatePoints = tableById(GRACE_2006, 'heart_rate_points');
const systolicBpPoints = tableById(GRACE_2006, 'systolic_bp_points');
const creatininePoints = tableById(GRACE_2006, 'creatinine_points');
const mortalityPercent = tableById(GRACE_2006, 'mortality_percent');

function grace(inputs: CalculatorInputsById['grace']): CalculatorOutputsById['grace'] {
  const total =
    evaluateLinearTable(agePoints, inputs.age) +
    evaluateLinearTable(heartRatePoints, inputs.heart_rate) +
    evaluateLinearTable(systolicBpPoints, inputs.systolic_bp) +
    evaluateLinearTable(creatininePoints, inputs.creatinine) +
    GRACE_2006.categories[`killip_${inputs.killip_class}`]! +
    (inputs.cardiac_arrest ? GRACE_2006.coefficients.cardiac_arrest! : 0) +
    (inputs.st_segment_deviation ? GRACE_2006.coefficients.st_deviation! : 0) +
    (inputs.elevated_cardiac_enzymes ? GRACE_2006.coefficients.cardiac_enzymes! : 0);

  const score = roundHalfEven(total);
  return { score, mortality_risk: evaluateLookupTable(mortalityPercent, score) };
}

registerCompute('grace', grace);
