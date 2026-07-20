/**
 * TIMI Risk Score — unstable angina / non-ST-elevation MI.
 *
 * One point each for seven clinical criteria. The score maps to a 14-day risk
 * estimate, while risk strata are declared in `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

// Score (0-7) to 14-day risk of death, MI, or urgent revascularization.
const RISK_TABLE: Record<number, CalculatorOutputsById['timi']['risk_percentage']> = {
  0: '4.7%',
  1: '4.7%',
  2: '8.3%',
  3: '13.2%',
  4: '19.9%',
  5: '26.2%',
  6: '40.9%',
  7: '40.9%',
};

function timi(inputs: CalculatorInputsById['timi']): CalculatorOutputsById['timi'] {
  const score = sumDeclaredScore('timi', inputs).total as number;
  const risk_percentage = RISK_TABLE[score];
  return {
    score,
    risk_percentage,
    risk_percent: Number.parseFloat(risk_percentage),
    risk_horizon_days: 14,
    risk_endpoint: 'death_mi_or_urgent_revascularization',
  };
}

registerCompute('timi', timi);
