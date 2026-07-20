import * as z from 'zod/v4';
import type { CalcSpec, InputSpec, OutputSpec } from '../engine/spec-schema.js';
import { ENGINE_ERROR_CODES } from '../engine/errors.js';
import { convert, resolveUnit } from '../engine/units.js';
import { VALIDATION_REVIEW_STATES } from './validation-state.generated.js';

export interface CalculatorCompatibilityContract {
  inputs: Record<string, {
    required: boolean;
    kind: InputSpec['kind'];
    enumValues?: string[];
    enumAliases?: Record<string, string[]>;
    quantity?: { canonicalUnit: string; acceptedUnits: string[] };
    default?: number | string | boolean;
  }>;
  conditionalRequirements: Array<
    { kind: 'requiredWithAliases'; fields: string[] } |
    NonNullable<CalcSpec['constraints']>[number]
  >;
  outputs: Record<string, {
    kind: OutputSpec['kind'];
    allowedValues?: string[];
    unit?: string;
    availability: OutputSpec['availability'];
  }>;
}

/** Shared normalized field contract consumed by both direct and compact MCP paths. */
export function buildCalculatorCompatibilityContract(spec: CalcSpec): CalculatorCompatibilityContract {
  const inputs = Object.fromEntries(Object.entries(spec.inputs).map(([name, input]) => {
    const contract: CalculatorCompatibilityContract['inputs'][string] = {
      required: input.required,
      kind: input.kind,
    };
    if (input.kind === 'enum') {
      contract.enumValues = input.enumValues.map((option) => option.value).sort();
      const aliases = Object.fromEntries(input.enumValues
        .filter((option) => (option.aliases?.length ?? 0) > 0)
        .map((option) => [option.value, [...(option.aliases ?? [])].sort()]));
      if (Object.keys(aliases).length > 0) contract.enumAliases = aliases;
    }
    if (input.kind === 'quantity') {
      contract.quantity = {
        canonicalUnit: input.quantity.canonicalUnit,
        acceptedUnits: [...input.quantity.acceptedUnits].sort(),
      };
    }
    if (input.default !== undefined) contract.default = input.default;
    return [name, contract];
  }));
  const conditionalRequirements: CalculatorCompatibilityContract['conditionalRequirements'] = [];
  for (const [name, input] of Object.entries(spec.inputs)) {
    if (input.required && (input.aliases?.length ?? 0) > 0) {
      conditionalRequirements.push({
        kind: 'requiredWithAliases',
        fields: [name, ...(input.aliases ?? [])].sort(),
      });
    }
  }
  conditionalRequirements.push(...structuredClone(spec.constraints ?? []));
  conditionalRequirements.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const outputs = Object.fromEntries(Object.entries(spec.outputs).map(([name, output]) => {
    const contract: CalculatorCompatibilityContract['outputs'][string] = {
      kind: output.kind,
      availability: structuredClone(output.availability),
    };
    if (output.kind === 'enum') contract.allowedValues = [...output.allowedValues].sort();
    if ('unit' in output && output.unit !== undefined) contract.unit = output.unit;
    return [name, contract];
  }));
  return { inputs, conditionalRequirements, outputs };
}

function nonEmptyEnum(values: string[], context: string): [string, ...string[]] {
  if (values.length === 0) throw new Error(`${context}: expected at least one value.`);
  return values as [string, ...string[]];
}

function inputFieldSchema(name: string, input: InputSpec): z.ZodType {
  let schema: z.ZodType;
  const number = (): z.ZodNumber => {
    let value = z.number().finite();
    if (input.kind !== 'boolean' && input.kind !== 'enum' && input.hardLimits !== undefined) {
      value = value.min(input.hardLimits[0]).max(input.hardLimits[1]);
    }
    return value;
  };
  switch (input.kind) {
    case 'number':
      schema = number();
      break;
    case 'integer':
      schema = z.number().finite().int();
      if (input.hardLimits !== undefined) {
        schema = (schema as z.ZodNumber).min(input.hardLimits[0]).max(input.hardLimits[1]);
      }
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'enum':
      schema = z.enum(nonEmptyEnum(
        input.enumValues.flatMap((option) => [option.value, ...(option.aliases ?? [])]),
        `${name} options`,
      ));
      break;
    case 'quantity': {
      const quantity = input.quantity;
      const boundedQuantity = z.strictObject({
        value: z.number().finite(),
        unit: z.string().trim().min(1),
      }).superRefine((supplied, ctx) => {
        const resolvedUnit = resolveUnit(quantity.analyte, supplied.unit);
        if (resolvedUnit === undefined || !quantity.acceptedUnits.includes(resolvedUnit)) {
          ctx.addIssue({
            code: 'custom',
            path: ['unit'],
            message: `Expected one of: ${quantity.acceptedUnits.join(', ')}`,
          });
          return;
        }
        if (input.hardLimits !== undefined) {
          const canonical = convert(
            quantity.analyte,
            supplied.value,
            supplied.unit,
            quantity.canonicalUnit,
          );
          if (canonical < input.hardLimits[0] || canonical > input.hardLimits[1]) {
            ctx.addIssue({
              code: 'custom',
              path: ['value'],
              message: `Expected ${input.hardLimits[0]}–${input.hardLimits[1]} ${quantity.canonicalUnit}`,
            });
          }
        }
      });
      schema = z.union([
        number().describe(`Bare number interpreted as ${quantity.canonicalUnit}`),
        boundedQuantity,
      ]);
      break;
    }
  }
  return schema.describe(input.description);
}

/**
 * Exact strict parser for canonical fields and documented compatibility aliases.
 * Required fields with aliases are conditional: one spelling is required and
 * multiple spellings are rejected as ambiguous.
 */
export function buildCalculatorInputSchema(spec: CalcSpec): z.ZodObject {
  const contract = buildCalculatorCompatibilityContract(spec);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, input] of Object.entries(spec.inputs)) {
    const inputContract = contract.inputs[name]!;
    const aliases = input.aliases ?? [];
    const field = inputFieldSchema(name, input);
    shape[name] = inputContract.required && aliases.length === 0 ? field : field.optional();
    for (const alias of aliases) {
      shape[alias] = field.optional().describe(`Compatibility alias for ${name}. Prefer ${name}.`);
    }
  }
  const aliasRequirements = contract.conditionalRequirements
    .filter((requirement) => requirement.kind === 'requiredWithAliases')
    .map((requirement) => ({
      anyOf: requirement.fields.map((candidate) => ({ required: [candidate] })),
    }));
  return z.strictObject(shape).superRefine((inputs, ctx) => {
    for (const [name, input] of Object.entries(spec.inputs)) {
      const inputContract = contract.inputs[name]!;
      const supplied = [name, ...(input.aliases ?? [])].filter((candidate) => inputs[candidate] !== undefined);
      if (inputContract.required && supplied.length === 0) {
        ctx.addIssue({ code: 'custom', path: [name], message: `Required input: ${name}` });
      }
      if (supplied.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `Provide ${name} once; do not combine it with compatibility aliases.`,
        });
      }
    }
  }).meta({
    ...(aliasRequirements.length > 0 ? { allOf: aliasRequirements } : {}),
  });
}

const numberRangeSchema = z.strictObject({
  low: z.number().finite(),
  high: z.number().finite(),
  mean: z.number().finite().optional(),
}).refine(({ low, high, mean }) => low <= high && (mean === undefined || (low <= mean && mean <= high)), {
  message: 'range values must satisfy low <= mean <= high',
});

function outputValueSchema(output: OutputSpec): z.ZodType {
  switch (output.kind) {
    case 'number': {
      let value = z.number().finite();
      if (output.range !== undefined) value = value.min(output.range[0]).max(output.range[1]);
      return value;
    }
    case 'integer': {
      let value = z.number().finite().int();
      if (output.range !== undefined) value = value.min(output.range[0]).max(output.range[1]);
      return value;
    }
    case 'boolean':
      return z.boolean();
    case 'string':
      return z.string();
    case 'enum':
      return z.enum(nonEmptyEnum(output.allowedValues, 'output enum'));
    case 'string_list':
      return z.array(z.string());
    case 'number_list': {
      let item = z.number().finite();
      if (output.itemRange !== undefined) item = item.min(output.itemRange[0]).max(output.itemRange[1]);
      return z.array(item);
    }
    case 'number_range':
      return output.range === undefined
        ? numberRangeSchema
        : numberRangeSchema.refine(
          ({ low, high, mean }) =>
            low >= output.range![0] &&
            high <= output.range![1] &&
            (mean === undefined || (mean >= output.range![0] && mean <= output.range![1])),
          { message: `range values must stay within ${output.range[0]}–${output.range[1]}` },
        );
    case 'criterion_list':
      return z.array(z.strictObject({
        criterion: z.string().min(1),
        state: z.enum(['met', 'not_met', 'unknown', 'not_due', 'not_applicable']),
        points: z.number().finite().optional(),
        observedInputs: z.array(z.string()),
        rationale: z.string().min(1),
      }));
  }
}

function unionOf(schemas: z.ZodType[]): z.ZodType {
  if (schemas.length === 0) return z.never();
  if (schemas.length === 1) return schemas[0];
  return z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

export const errorPayloadSchema = z.strictObject({
  code: z.enum([...ENGINE_ERROR_CODES, 'INTERNAL_ERROR']),
  error: z.string(),
  field: z.string(),
  expected: z.string(),
  allowed: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

/** Compact advertised shape for recoverable MCP tool failures. */
export const recoverableToolErrorSchema = z.looseObject({
  code: z.string(),
  error: z.string(),
  field: z.string(),
  expected: z.string(),
});

const resultClinicalModelSchema = z.strictObject({
  modelKind: z.enum(['formula', 'score', 'decision_tree', 'policy', 'lookup']),
  modelId: z.string(),
  modelVersion: z.string(),
  jurisdiction: z.string().optional(),
  dataSnapshot: z.string().optional(),
  effectiveDate: z.iso.date().optional(),
  reviewDate: z.iso.date().optional(),
  reviewAfter: z.iso.date().optional(),
  stale: z.boolean(),
});

const resultInterpretationSchema = z.strictObject({
  label: z.string(),
  severity: z.enum(['normal', 'borderline', 'abnormal', 'critical']),
});

const resultInterpretationsSchema = z.array(z.strictObject({
  output: z.string(),
  code: z.string(),
  kind: z.enum(['stage', 'risk', 'likelihood', 'severity', 'screening', 'class', 'status']),
  label: z.string(),
  severity: z.enum(['normal', 'borderline', 'abnormal', 'critical']),
  evidenceRefs: z.array(z.string()),
}));

const usedInputSchema = z.strictObject({
  value: z.union([z.number(), z.string(), z.boolean()]),
  unit: z.string().optional(),
});

const inputProvenanceSchema = z.strictObject({
  source: z.enum(['supplied', 'default', 'alias']),
  suppliedAs: z.string(),
  original: z.strictObject({ value: z.number(), unit: z.string().optional() }).optional(),
  normalized: usedInputSchema,
});

const adjustmentEventSchema = z.strictObject({
  id: z.string(),
  target: z.strictObject({ kind: z.enum(['input', 'output']), field: z.string() }),
  operation: z.enum(['cap', 'floor', 'clamp']),
  original: z.number(),
  effective: z.number(),
  applied: z.boolean(),
  conditionMatched: z.boolean(),
  bounds: z.strictObject({ minimum: z.number().optional(), maximum: z.number().optional() }),
  verifyOutput: z.string().optional(),
  verifyTolerance: z.number().optional(),
  appliedOutput: z.string().optional(),
  evidenceRefs: z.array(z.string()),
});

const scoringComponentSchema = z.strictObject({
  field: z.string(),
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  points: z.number().optional(),
  testable: z.boolean(),
  reason: z.string().optional(),
});

const resultEvidenceSchema = z.strictObject({
  id: z.string(),
  type: z.string(),
  citation: z.string(),
  locator: z.string(),
  doi: z.string().optional(),
  url: z.string().optional(),
});

/** One deep result-envelope module, specialized only at identity/result seams. */
function calcResultEnvelopeSchema(identity: {
  id: z.ZodType;
  version: z.ZodType;
  results: z.ZodType;
  evidenceUri: z.ZodType;
}): z.ZodObject {
  return z.strictObject({
    schemaVersion: z.literal('1.1'),
    id: identity.id,
    version: identity.version,
    clinicalModel: resultClinicalModelSchema,
    results: identity.results,
    interpretation: resultInterpretationSchema.optional(),
    interpretations: resultInterpretationsSchema,
    warnings: z.array(z.string()),
    inputsUsed: z.record(z.string(), usedInputSchema),
    inputProvenance: z.record(z.string(), inputProvenanceSchema),
    adjustments: z.array(adjustmentEventSchema),
    scoringComponents: z.array(scoringComponentSchema),
    scoreComplete: z.boolean(),
    scoreMissingReasons: z.array(z.string()),
    evidence: z.array(resultEvidenceSchema),
    evidenceUri: identity.evidenceUri,
  });
}

/** Exact schema-1.1 result envelope for one calculator. */
export function buildCalcResultSchema(spec: CalcSpec): z.ZodObject {
  const contract = buildCalculatorCompatibilityContract(spec);
  const resultEntries = Object.keys(contract.outputs).map((name) => {
    const output = spec.outputs[name]!;
    return z.strictObject({
      name: z.literal(name),
      title: z.literal(output.title),
      value: outputValueSchema(output),
      unit: output.unit === undefined ? z.never().optional() : z.literal(output.unit),
    });
  });
  return calcResultEnvelopeSchema({
    id: z.literal(spec.id),
    version: z.literal(spec.version),
    results: z.array(unionOf(resultEntries)),
    evidenceUri: z.literal(`calc://${spec.id}/evidence`),
  });
}

/*
 * The dispatcher advertises one stable catalog-wide envelope. Runtime input
 * validation is still selected from the exact calculator schema, and every
 * result is still produced by `run()`. Repeating all 39 exact result schemas in
 * both aggregate tools made a four-tool compact catalog almost as large as the
 * full catalog; it added no runtime safety because the selected calculator is
 * already validated before this envelope is emitted.
 */
const catalogOutputValueSchema = z.union([
  z.number().finite(),
  z.string(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number().finite()),
  numberRangeSchema,
  z.array(z.strictObject({
    criterion: z.string().min(1),
    state: z.enum(['met', 'not_met', 'unknown', 'not_due', 'not_applicable']),
    points: z.number().finite().optional(),
    observedInputs: z.array(z.string()),
    rationale: z.string().min(1),
  })),
]);

const catalogCalcResultSchema = calcResultEnvelopeSchema({
  id: z.string().min(1),
  version: z.string().min(1),
  results: z.array(z.strictObject({
    name: z.string().min(1),
    title: z.string().min(1),
    value: catalogOutputValueSchema,
    unit: z.string().optional(),
  })),
  evidenceUri: z.string().startsWith('calc://'),
});

const catalogEntrySchema = z.discriminatedUnion('ok', [
  z.strictObject({ calculator: z.string().min(1), ok: z.literal(true), result: catalogCalcResultSchema }),
  z.strictObject({ calculator: z.string().min(1), ok: z.literal(false), error: errorPayloadSchema }),
]);

export function buildPanelResultSchema(): z.ZodObject {
  return z.strictObject({
    results: z.array(catalogEntrySchema),
    error: recoverableToolErrorSchema.optional(),
  });
}

export function buildCompactDispatchResultSchema(): z.ZodObject {
  return z.strictObject({ result: catalogEntrySchema });
}

const descriptorInputSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  conceptId: z.string(),
  sharedKey: z.string().optional(),
  kind: z.enum(['number', 'integer', 'boolean', 'enum', 'quantity']),
  required: z.boolean(),
  deprecated: z.boolean().optional(),
  default: z.union([z.number(), z.string(), z.boolean()]).optional(),
  aliases: z.array(z.string()),
  hardLimits: z.tuple([z.number(), z.number()]).optional(),
  canonicalUnit: z.string().optional(),
  acceptedUnits: z.array(z.string()).optional(),
  observation: z.strictObject({
    phase: z.enum(['admission', 'follow_up']),
    timestampField: z.string(),
    derivation: z.enum(['threshold', 'change_from_baseline']),
    baselineField: z.string().optional(),
  }).optional(),
  options: z.array(z.strictObject({
    value: z.string(),
    label: z.string(),
    description: z.string(),
    points: z.number().optional(),
    scorable: z.boolean().optional(),
  })).optional(),
});

const fieldConditionSchema = z.strictObject({ field: z.string(), when: z.string() });
const constraintValueSchema = z.union([z.number(), z.string(), z.boolean()]);
const descriptorConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('compare'),
    left: z.string(),
    operator: z.enum(['<', '<=', '>', '>=', '==', '!=']),
    right: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('atLeastOne'),
    fields: z.array(z.string()),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('requiredWhen'),
    field: z.string(),
    when: z.string(),
    required: z.array(z.string()),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('requireValueWhen'),
    field: z.string(),
    when: z.string(),
    where: z.array(fieldConditionSchema).optional(),
    target: z.string(),
    value: constraintValueSchema,
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('forbidValueWhen'),
    field: z.string(),
    when: z.string(),
    where: z.array(fieldConditionSchema).optional(),
    target: z.string(),
    value: constraintValueSchema,
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('requireAtLeastValuesWhen'),
    field: z.string(),
    when: z.string(),
    targets: z.array(z.strictObject({ field: z.string(), value: constraintValueSchema })),
    minimum: z.number().int().positive().optional(),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('forbidPresentWhen'),
    field: z.string(),
    when: z.string(),
    forbidden: z.array(z.string()),
    message: z.string(),
  }),
]);

const descriptorAvailabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('always') }),
  z.strictObject({ kind: z.literal('whenAnyInputPresent'), fields: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('whenAllInputsPresent'), fields: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('computeCondition'), conditionId: z.string() }),
]);

const descriptorOutputSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  kind: z.enum(['number', 'integer', 'boolean', 'string', 'enum', 'string_list', 'number_list', 'number_range', 'criterion_list']),
  unit: z.string().optional(),
  allowedValues: z.array(z.string()).optional(),
  range: z.tuple([z.number(), z.number()]).optional(),
  itemRange: z.tuple([z.number(), z.number()]).optional(),
  availability: descriptorAvailabilitySchema,
});

export const calculatorDescriptorSchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  family: z.string().optional(),
  variant: z.string().optional(),
  synonyms: z.array(z.string()),
  abbreviations: z.array(z.string()),
  purposeForAgents: z.string(),
  clinicalModel: z.strictObject({
    modelKind: z.enum(['formula', 'score', 'decision_tree', 'policy', 'lookup']),
    modelId: z.string(),
    modelVersion: z.string(),
    jurisdiction: z.string().optional(),
    dataSnapshot: z.string().optional(),
    effectiveDate: z.string().optional(),
    reviewDate: z.string().optional(),
  }),
  applicability: z.strictObject({
    population: z.string(),
    setting: z.string(),
    exclusions: z.array(z.string()),
  }),
  inputs: z.record(z.string(), descriptorInputSchema),
  outputs: z.record(z.string(), descriptorOutputSchema),
  primaryOutputs: z.array(z.string()),
  constraints: z.array(descriptorConstraintSchema),
  evidenceUri: z.string(),
  reviewState: z.strictObject({
    state: z.enum(['pending', 'blocked', 'stale', 'search_complete', 'source_verified', 'scenario_verified']),
    blockerCodes: z.array(z.string()),
    counts: z.strictObject({
      claimsTotal: z.number(),
      claimsSupported: z.number(),
      requiredCases: z.number(),
      passedCases: z.number(),
      executableClaims: z.number(),
      witnessedExecutableClaims: z.number(),
    }),
  }),
});

export type CalculatorDescriptor = z.infer<typeof calculatorDescriptorSchema>;

export function buildCalculatorDescriptor(spec: CalcSpec): CalculatorDescriptor {
  const reviewState = VALIDATION_REVIEW_STATES[spec.id as keyof typeof VALIDATION_REVIEW_STATES];
  if (reviewState === undefined) throw new Error(`Missing generated validation review state for '${spec.id}'.`);
  return {
    id: spec.id,
    version: spec.version,
    name: spec.name,
    ...(spec.family === undefined ? {} : { family: spec.family }),
    ...(spec.variant === undefined ? {} : { variant: spec.variant }),
    synonyms: spec.synonyms ?? [],
    abbreviations: spec.abbreviations ?? [],
    purposeForAgents: spec.purposeForAgents,
    clinicalModel: {
      modelKind: spec.clinicalModel.modelKind,
      modelId: spec.clinicalModel.modelId,
      modelVersion: spec.clinicalModel.modelVersion,
      ...(spec.clinicalModel.jurisdiction === undefined ? {} : { jurisdiction: spec.clinicalModel.jurisdiction }),
      ...(spec.clinicalModel.dataSnapshot === undefined ? {} : { dataSnapshot: spec.clinicalModel.dataSnapshot }),
      ...(spec.clinicalModel.effectiveDate === undefined ? {} : { effectiveDate: spec.clinicalModel.effectiveDate }),
      ...(spec.clinicalModel.reviewDate === undefined ? {} : { reviewDate: spec.clinicalModel.reviewDate }),
    },
    applicability: {
      population: spec.applicability.population,
      setting: spec.applicability.setting,
      exclusions: spec.applicability.exclusions,
    },
    inputs: Object.fromEntries(Object.entries(spec.inputs).map(([name, input]) => [name, {
      title: input.title,
      description: input.description,
      conceptId: input.conceptId,
      ...(input.sharedKey === undefined ? {} : { sharedKey: input.sharedKey }),
      kind: input.kind,
      required: input.required,
      ...(input.deprecated === true ? { deprecated: true } : {}),
      ...('default' in input && input.default !== undefined ? { default: input.default } : {}),
      aliases: input.aliases ?? [],
      ...('hardLimits' in input && input.hardLimits !== undefined ? { hardLimits: input.hardLimits } : {}),
      ...(input.kind === 'quantity' ? {
        canonicalUnit: input.quantity.canonicalUnit,
        acceptedUnits: input.quantity.acceptedUnits,
      } : {}),
      ...('observation' in input && input.observation !== undefined ? { observation: input.observation } : {}),
      ...(input.kind === 'enum' ? {
        options: input.enumValues.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description,
          ...(option.points === undefined ? {} : { points: option.points }),
          ...(option.scorable === undefined ? {} : { scorable: option.scorable }),
        })),
      } : {}),
    }])),
    outputs: Object.fromEntries(Object.entries(spec.outputs).map(([name, output]) => [name, {
      title: output.title,
      description: output.description,
      kind: output.kind,
      ...('unit' in output && output.unit !== undefined ? { unit: output.unit } : {}),
      ...(output.kind === 'enum' ? { allowedValues: output.allowedValues } : {}),
      ...('range' in output && output.range !== undefined ? { range: output.range } : {}),
      ...(output.kind === 'number_list' && output.itemRange !== undefined
        ? { itemRange: output.itemRange }
        : {}),
      availability: output.availability,
    }])),
    primaryOutputs: spec.primaryOutputs,
    constraints: spec.constraints ?? [],
    evidenceUri: `calc://${spec.id}/evidence`,
    reviewState: {
      state: reviewState.state,
      blockerCodes: [...reviewState.blockerCodes],
      counts: { ...reviewState.counts },
    },
  };
}
