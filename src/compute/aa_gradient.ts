/**
 * A-a Gradient — Alveolar–arterial oxygen gradient.
 *
 * Alveolar gas equation:
 *   PAO2 = (FiO2_decimal × (Patm − PH2O)) − (PaCO2 / 0.8)
 *   A-a gradient = PAO2 − PaO2
 *   expected_gradient = 4 + age/4
 * with Patm from NASA's metric troposphere curve fit:
 * T = 15.04 − 0.00649 × altitude_m
 * p_kPa = 101.29 × ((T + 273.1) / 288.08)^5.256,
 * PH2O = 47 mmHg, respiratory quotient 0.8. Altitude defaults to sea level (0).
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function aaGradient(inputs: CalculatorInputsById['aa_gradient']): CalculatorOutputsById['aa_gradient'] {
  const { pao2, paco2, fio2, age, altitude } = inputs;

  const fio2Decimal = fio2 / 100;
  const respiratoryQuotient = 0.8;
  const ph2o = 47;

  const atmosphericTemperatureC = 15.04 - 0.00649 * altitude;
  const atmosphericPressureKpa = 101.29 * ((atmosphericTemperatureC + 273.1) / 288.08) ** 5.256;
  const patm = atmosphericPressureKpa * 760 / 101.325;
  const pao2Calc = fio2Decimal * (patm - ph2o) - paco2 / respiratoryQuotient;
  const aa = pao2Calc - pao2;
  const expected = 4 + age / 4;

  return {
    aa_gradient: roundHalfEven(aa, 2),
    expected_gradient: roundHalfEven(expected, 2),
  };
}

registerCompute('aa_gradient', aaGradient);
