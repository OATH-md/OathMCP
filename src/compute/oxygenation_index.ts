/**
 * Oxygenation Index (OI) / Oxygen Saturation Index (OSI).
 *
 * Equations:
 *   OI  = (MAP × FiO2_decimal × 100) / PaO2    (when PaO2 provided)
 *   OSI = (MAP × FiO2_decimal × 100) / SpO2    (when SpO2 provided)
 * Only indexes with a supplied denominator are returned. The spec requires at
 * least one of PaO2 or SpO2, and the engine enforces that constraint.
 */
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

function oxygenationIndex(inputs: CalculatorInputsById['oxygenation_index']): CalculatorOutputsById['oxygenation_index'] {
  const {
    mean_airway_pressure: meanAirwayPressure,
    fio2,
    pao2,
    spo2,
  } = inputs;

  const fio2Decimal = fio2 / 100;
  const result: Record<string, number> = {};

  if (pao2 !== undefined) {
    result.oi = roundHalfEven((meanAirwayPressure * fio2Decimal * 100) / pao2, 2);
  }
  if (spo2 !== undefined) {
    result.osi = roundHalfEven((meanAirwayPressure * fio2Decimal * 100) / spo2, 2);
  }

  return result;
}

registerCompute('oxygenation_index', oxygenationIndex);
