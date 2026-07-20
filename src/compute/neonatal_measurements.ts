/**
 * Neonatal Measurements — umbilical catheter depths, ETT depth, expected
 * blood pressure ranges.
 *
 * Every input is optional; the compute function returns only the outputs whose
 * inputs were supplied,
 * and the engine (`run.ts`) omits absent outputs — a call with no usable inputs
 * produces nothing and the runner raises an InputError. The ETT and blood
 * pressure lookup tables use closed, contiguous clinical ranges.
 *
 * Formulae (Shukla): UAC = weight_kg×3 + 9; UVC = (3×weight_kg + 9)/2 + 1.
 */
import { registerCompute } from '../engine/registry.js';
import { registerOutputCondition } from '../engine/output-availability.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

type Inputs = CalculatorInputsById['neonatal_measurements'];
type Outputs = CalculatorOutputsById['neonatal_measurements'];

interface EttRange {
  min: number;
  max: number;
  depth: number;
}

const ETT_PARAMS: EttRange[] = [
  { min: 23, max: 24, depth: 5.5 },
  { min: 25, max: 26, depth: 6.0 },
  { min: 27, max: 29, depth: 6.5 },
  { min: 30, max: 32, depth: 7.0 },
  { min: 33, max: 34, depth: 7.5 },
  { min: 35, max: 37, depth: 8.0 },
  { min: 38, max: 40, depth: 8.5 },
  { min: 41, max: 43, depth: 9.0 },
];

// Each row: [sysLow, sysMean, sysHigh, diaLow, diaMean, diaHigh,
//            mapLow, mapMean, mapHigh, ppLow, ppMean, ppHigh]
const BP_DAY_ONE: Record<number, number[]> = {
  22: [22, 39, 55, 14, 23, 31, 17, 28, 39, 8, 12, 18],
  23: [23, 40, 56, 15, 24, 32, 18, 29, 40, 8, 12, 18],
  24: [25, 42, 57, 16, 25, 33, 19, 31, 41, 8, 12, 18],
  25: [26, 43, 58, 17, 26, 34, 20, 32, 42, 8, 12, 18],
  26: [27, 44, 60, 18, 27, 35, 21, 33, 43, 8, 12, 18],
  27: [29, 45, 61, 19, 28, 36, 22, 34, 44, 8, 12, 18],
  28: [31, 47, 63, 20, 29, 37, 24, 35, 46, 9, 13, 19],
  29: [33, 48, 64, 21, 30, 38, 25, 36, 47, 9, 13, 19],
  30: [35, 50, 66, 22, 31, 39, 26, 37, 48, 9, 13, 19],
  31: [36, 51, 68, 23, 32, 40, 27, 38, 49, 10, 14, 20],
  32: [37, 52, 69, 24, 33, 41, 28, 39, 50, 10, 14, 20],
  33: [38, 53, 70, 25, 34, 42, 29, 40, 51, 10, 14, 20],
  34: [40, 55, 71, 26, 35, 43, 31, 42, 52, 10, 14, 20],
  35: [41, 57, 73, 27, 36, 44, 32, 43, 54, 10, 14, 20],
  36: [42, 59, 75, 28, 37, 45, 33, 44, 55, 10, 14, 20],
  37: [44, 60, 76, 29, 38, 46, 34, 45, 56, 10, 14, 20],
  38: [46, 61, 77, 30, 39, 47, 35, 46, 57, 12, 15, 21],
  39: [47, 62, 79, 31, 40, 48, 36, 47, 58, 12, 15, 21],
  40: [48, 64, 81, 32, 41, 49, 37, 49, 60, 12, 15, 21],
  41: [50, 65, 82, 33, 42, 50, 39, 50, 61, 12, 15, 22],
  42: [51, 67, 84, 34, 43, 51, 40, 51, 62, 12, 15, 22],
};

const BP_CORRECTED: Record<number, number[]> = {
  24: [33, 49, 68, 14, 29, 46, 20, 36, 53, 12, 16, 25],
  25: [36, 51, 69, 15, 30, 47, 22, 37, 54, 12, 16, 25],
  26: [38, 52, 70, 17, 31, 48, 24, 38, 55, 14, 16, 25],
  27: [40, 54, 71, 18, 32, 49, 25, 39, 56, 14, 16, 25],
  28: [41, 55, 72, 19, 33, 50, 26, 40, 57, 15, 17, 27],
  29: [42, 56, 73, 20, 34, 51, 27, 41, 58, 15, 17, 27],
  30: [43, 59, 75, 21, 35, 52, 28, 43, 60, 15, 18, 28],
  31: [46, 61, 78, 22, 36, 53, 30, 44, 61, 17, 20, 28],
  32: [48, 62, 80, 23, 37, 54, 31, 45, 63, 17, 20, 28],
  33: [50, 63, 81, 24, 38, 55, 33, 46, 64, 17, 20, 28],
  34: [51, 66, 83, 25, 39, 56, 34, 48, 65, 18, 21, 30],
  35: [52, 69, 84, 26, 40, 57, 35, 50, 66, 18, 21, 30],
  36: [55, 71, 87, 27, 41, 58, 36, 51, 68, 18, 22, 30],
  37: [57, 72, 89, 28, 42, 59, 38, 52, 69, 18, 22, 30],
  38: [59, 75, 90, 29, 43, 60, 39, 54, 70, 18, 22, 30],
  39: [60, 78, 91, 30, 44, 60, 40, 55, 70, 18, 22, 30],
  40: [61, 80, 92, 30, 44, 61, 40, 56, 71, 20, 25, 33],
  41: [62, 81, 93, 31, 46, 62, 41, 58, 72, 20, 25, 33],
  42: [63, 82, 95, 32, 47, 63, 42, 59, 74, 20, 25, 33],
  43: [65, 83, 97, 33, 48, 64, 44, 60, 75, 20, 25, 33],
  44: [67, 86, 98, 34, 49, 65, 45, 61, 76, 20, 25, 33],
  45: [69, 88, 100, 35, 50, 66, 46, 63, 77, 20, 25, 33],
  46: [71, 89, 102, 36, 51, 66, 48, 64, 78, 21, 25, 33],
};

function bpRange(row: number[], offset: number): { low: number; mean: number; high: number } {
  return { low: row[offset] as number, mean: row[offset + 1] as number, high: row[offset + 2] as number };
}

function neonatalMeasurements(inputs: Inputs): Outputs {
  const weightGrams = inputs.weight_grams;
  const gestationalAge = inputs.gestational_age_weeks;
  const correctedGestationalAge = inputs.corrected_gestational_age_weeks;
  const postnatalAgeHours = inputs.postnatal_age_hours;

  const result: Outputs = { limitations: [] };

  if (weightGrams !== undefined) {
    const weightKg = weightGrams / 1000;
    result.uac_depth_estimate_cm = roundHalfEven(weightKg * 3 + 9, 1);
    result.uvc_depth_estimate_cm = roundHalfEven((3 * weightKg + 9) / 2 + 1, 1);
    result.catheter_formula_id = 'shukla_1986_original';
    result.limitations.push('catheter_estimate_requires_direct_tip_position_confirmation');
    result.limitations.push('original_shukla_uvc_formula_has_documented_over_insertion_risk');
  }

  if (gestationalAge !== undefined) {
    const ett = ETT_PARAMS.find((e) => gestationalAge >= e.min && gestationalAge <= e.max);
    if (ett !== undefined) {
      result.ett_depth_at_lip_cm = ett.depth;
      result.limitations.push('ett_estimate_requires_clinical_and_position_confirmation');
    }

    const row = BP_DAY_ONE[gestationalAge];
    if (row !== undefined && postnatalAgeHours !== undefined && postnatalAgeHours <= 24) {
      result.day_one_systolic_bp_mm_hg = bpRange(row, 0);
      result.day_one_diastolic_bp_mm_hg = bpRange(row, 3);
      result.day_one_map_mm_hg = bpRange(row, 6);
      result.day_one_pulse_pressure_mm_hg = bpRange(row, 9);
      result.limitations.push('day_one_bp_values_are_descriptive_references_not_treatment_thresholds');
    } else if (row !== undefined) {
      result.limitations.push('day_one_bp_requires_explicit_postnatal_age_0_to_24_hours');
    }
  }

  if (correctedGestationalAge !== undefined) {
    const crow = BP_CORRECTED[correctedGestationalAge];
    if (crow !== undefined) {
      result.corrected_systolic_bp_mm_hg = bpRange(crow, 0);
      result.corrected_diastolic_bp_mm_hg = bpRange(crow, 3);
      result.corrected_map_mm_hg = bpRange(crow, 6);
      result.corrected_pulse_pressure_mm_hg = bpRange(crow, 9);
      result.limitations.push('corrected_age_bp_values_are_descriptive_references_not_treatment_thresholds');
    }
  }

  return result;
}

registerCompute('neonatal_measurements', neonatalMeasurements);
registerOutputCondition('neonatal_measurements', 'weight_supported', ({ inputs }) =>
  typeof inputs.weight_grams === 'number');
registerOutputCondition('neonatal_measurements', 'gestational_age_ett_supported', ({ inputs }) => {
  const age = inputs.gestational_age_weeks;
  return typeof age === 'number' && ETT_PARAMS.some((range) => age >= range.min && age <= range.max);
});
registerOutputCondition('neonatal_measurements', 'gestational_age_bp_supported', ({ inputs }) => {
  const age = inputs.gestational_age_weeks;
  const postnatalAge = inputs.postnatal_age_hours;
  return typeof age === 'number' &&
    BP_DAY_ONE[age] !== undefined &&
    typeof postnatalAge === 'number' &&
    postnatalAge <= 24;
});
registerOutputCondition('neonatal_measurements', 'corrected_age_bp_supported', ({ inputs }) => {
  const age = inputs.corrected_gestational_age_weeks;
  return typeof age === 'number' && BP_CORRECTED[age] !== undefined;
});
