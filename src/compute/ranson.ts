/** Ranson criteria derived from raw, timestamped observations. */
import { registerCompute } from '../engine/registry.js';
import { registerOutputCondition } from '../engine/output-availability.js';
import type {
  CalculatorInputsById,
  CalculatorOutputsById,
  CriterionProvenance,
  CriterionState,
} from './types.generated.js';

type Inputs = CalculatorInputsById['ranson'];
type Outputs = CalculatorOutputsById['ranson'];

function criterion(
  name: string,
  state: CriterionState,
  observedInputs: string[],
  rationale: string,
): CriterionProvenance {
  return {
    criterion: name,
    state,
    ...(state === 'met' ? { points: 1 } : state === 'not_met' || state === 'not_applicable' ? { points: 0 } : {}),
    observedInputs,
    rationale,
  };
}

function thresholdCriterion(
  name: string,
  value: number,
  threshold: number,
  operator: 'greater' | 'less',
  fields: string | string[],
  unit: string,
): CriterionProvenance {
  // Unit normalization can land a mathematically equal SI value a few ULPs
  // above or below the canonical threshold. Preserve the source's strict
  // greater-than/less-than boundary by treating only that conversion noise as
  // equality.
  const slack = Number.EPSILON * 32 * Math.max(1, Math.abs(value), Math.abs(threshold));
  const displayedValue = Math.abs(value - threshold) <= slack
    ? threshold
    : Number(value.toPrecision(15));
  const met = operator === 'greater'
    ? value > threshold + slack
    : value < threshold - slack;
  return criterion(
    name,
    met ? 'met' : 'not_met',
    Array.isArray(fields) ? fields : [fields],
    `${displayedValue} ${unit} ${operator === 'greater' ? '>' : '<'} ${threshold} ${unit} is ${met ? 'true' : 'false'}; equality does not meet this criterion.`,
  );
}

function followUpCriterion(
  inputs: Inputs,
  name: string,
  fields: string[],
  evaluate: () => CriterionProvenance,
): CriterionProvenance {
  if (inputs.assessment_hours < 48) {
    return criterion(name, 'not_due', [], 'The follow-up criterion is not due before 48 completed hours.');
  }
  const missing = fields.filter((field) => inputs[field as keyof Inputs] === undefined);
  if (missing.length > 0) {
    return criterion(name, 'unknown', fields.filter((field) => !missing.includes(field)), `Missing required raw observation(s): ${missing.join(', ')}.`);
  }
  return evaluate();
}

function isCompleted48HourAssessment(inputs: Inputs): boolean {
  const requiredFollowUp = [
    inputs.hematocrit_followup,
    inputs.bun_followup,
    inputs.calcium_followup,
    inputs.base_deficit_followup,
    inputs.fluid_sequestration_followup,
  ];
  return inputs.assessment_hours === 48 &&
    requiredFollowUp.every((value) => value !== undefined) &&
    (inputs.etiology_variant === 'gallstone' || inputs.pao2_followup !== undefined);
}

function derive(inputs: Inputs): {
  criteria: CriterionProvenance[];
  admissionSubtotal: number;
  complete: boolean;
  total?: number;
  missingReasons: string[];
} {
  const gallstone = inputs.etiology_variant === 'gallstone';
  const admission = [
    thresholdCriterion('wbc', inputs.wbc_admission, gallstone ? 18_000 : 16_000, 'greater', 'wbc_admission', 'cells/mm3'),
    thresholdCriterion('age', inputs.age_years, gallstone ? 70 : 55, 'greater', 'age_years', 'years'),
    thresholdCriterion('glucose', inputs.glucose_admission, gallstone ? 220 : 200, 'greater', 'glucose_admission', 'mg/dL'),
    thresholdCriterion('ast', inputs.ast_admission, 250, 'greater', 'ast_admission', 'U/L'),
    thresholdCriterion('ldh', inputs.ldh_admission, gallstone ? 400 : 350, 'greater', 'ldh_admission', 'U/L'),
  ];

  const followUp: CriterionProvenance[] = [
    followUpCriterion(inputs, 'hematocrit_drop', ['hematocrit_admission', 'hematocrit_followup'], () => {
      const drop = inputs.hematocrit_admission - (inputs.hematocrit_followup as number);
      return thresholdCriterion('hematocrit_drop', drop, 10, 'greater', ['hematocrit_admission', 'hematocrit_followup'], 'percentage points');
    }),
    followUpCriterion(inputs, 'bun_increase', ['bun_admission', 'bun_followup'], () => {
      const increase = (inputs.bun_followup as number) - inputs.bun_admission;
      return thresholdCriterion('bun_increase', increase, gallstone ? 2 : 5, 'greater', ['bun_admission', 'bun_followup'], 'mg/dL');
    }),
    followUpCriterion(inputs, 'calcium', ['calcium_followup'], () =>
      thresholdCriterion('calcium', inputs.calcium_followup as number, 8, 'less', 'calcium_followup', 'mg/dL')),
    gallstone
      ? criterion('pao2', 'not_applicable', [], 'Arterial pO2 is not part of the gallstone threshold set.')
      : followUpCriterion(inputs, 'pao2', ['pao2_followup'], () =>
        thresholdCriterion('pao2', inputs.pao2_followup as number, 60, 'less', 'pao2_followup', 'mmHg')),
    followUpCriterion(inputs, 'base_deficit', ['base_deficit_followup'], () =>
      thresholdCriterion('base_deficit', inputs.base_deficit_followup as number, gallstone ? 5 : 4, 'greater', 'base_deficit_followup', 'mEq/L')),
    followUpCriterion(inputs, 'fluid_sequestration', ['fluid_sequestration_followup'], () =>
      thresholdCriterion('fluid_sequestration', inputs.fluid_sequestration_followup as number, gallstone ? 4 : 6, 'greater', 'fluid_sequestration_followup', 'L')),
  ];

  const criteria = [...admission, ...followUp];
  const admissionSubtotal = admission.reduce((sum, item) => sum + (item.points ?? 0), 0);
  const incomplete = criteria.filter((item) => item.state === 'unknown' || item.state === 'not_due');
  const complete = isCompleted48HourAssessment(inputs);
  const total = complete ? criteria.reduce((sum, item) => sum + (item.points ?? 0), 0) : undefined;
  return {
    criteria,
    admissionSubtotal,
    complete,
    ...(total === undefined ? {} : { total }),
    missingReasons: incomplete.map((item) => `${item.criterion}: ${item.rationale}`),
  };
}

function historicalMortalityBand(score: number): NonNullable<Outputs['historical_mortality_band']> {
  if (score <= 2) return '~1%';
  if (score <= 4) return '~15%';
  if (score <= 6) return '~40%';
  return '~100%';
}

function ranson(inputs: Inputs): Outputs {
  const derived = derive(inputs);
  return {
    admission_subtotal: derived.admissionSubtotal,
    admission_complete: true,
    ...(derived.total === undefined ? {} : {
      score: derived.total,
      historical_mortality_band: historicalMortalityBand(derived.total),
    }),
    assessment_complete: derived.complete,
    missing_component_reasons: derived.missingReasons,
    criterion_provenance: derived.criteria,
  };
}

registerCompute('ranson', ranson);
registerOutputCondition('ranson', 'completed_48_hour_score', ({ inputs }) =>
  isCompleted48HourAssessment(inputs),
);
