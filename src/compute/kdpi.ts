/**
 * Kidney Donor Profile Index (KDPI) — updated OPTN coefficients (race/HCV-free).
 *
 * Computes the Kidney Donor Risk Index (KDRI) from donor factors, applies the
 * current scaling factor, then maps the scaled value to a percentile with the
 * official OPTN table. Creatinine arrives in canonical mg/dL and is capped at 8;
 * the runner emits a warning when the cap applies.
 */
import { evaluateLookupTable, KDPI_OPTN_2025, tableById } from '../clinical-data/index.js';
import { registerCompute } from '../engine/registry.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';
import { roundHalfEven } from './round.js';

const kdpiMapping = tableById(KDPI_OPTN_2025, 'kdpi_percentile');

function interpretation(kdpi: number): string {
  return `KDPI ${kdpi}% is a reference-population percentile, not a standalone accept/decline category; interpret it with the full donor, recipient, and offer context.`;
}

function kdpi(inputs: CalculatorInputsById['kdpi']): CalculatorOutputsById['kdpi'] {
  const age = inputs.donor_age_years;
  const height = inputs.donor_height_cm;
  const weight = inputs.donor_weight_kg;
  const creatinine = inputs.donor_creatinine;
  const coefficient = KDPI_OPTN_2025.coefficients;

  const xbeta =
    coefficient.age! * (age - 40) +
    coefficient.age_under_18! * (age - 18) * (age < 18 ? 1 : 0) +
    coefficient.age_over_50! * (age - 50) * (age > 50 ? 1 : 0) +
    coefficient.height! * ((height - 170) / 10) +
    coefficient.weight_under_80! * ((weight - 80) / 5) * (weight < 80 ? 1 : 0) +
    coefficient.hypertension! * (inputs.donor_hypertension ? 1 : 0) +
    coefficient.diabetes! * (inputs.donor_diabetes ? 1 : 0) +
    coefficient.cause_of_death_cva! * (inputs.cause_of_death_cva ? 1 : 0) +
    coefficient.creatinine! * (creatinine - 1) +
    coefficient.creatinine_over_1_5! * (creatinine - 1.5) * (creatinine > 1.5 ? 1 : 0) +
    coefficient.dcd! * (inputs.donation_after_circulatory_death ? 1 : 0);

  const kdriRaw = Math.exp(xbeta);
  const kdriScaled = kdriRaw / coefficient.scaling_factor!;
  const score = evaluateLookupTable(kdpiMapping, kdriScaled);

  return {
    kdpi: score,
    kdri_raw: roundHalfEven(kdriRaw, 4),
    kdri_scaled: roundHalfEven(kdriScaled, 4),
    reference_population_year: KDPI_OPTN_2025.categories.reference_population_year!,
    mapping_as_of: '2026-04-03',
    interpretation: interpretation(score),
  };
}

registerCompute('kdpi', kdpi);
