/**
 * Strict authoring contract for calculator specs.
 *
 * Every object is strict on purpose: a misspelled clinical field must fail at
 * load time instead of being silently discarded by Zod.
 */
import * as z from 'zod/v4';

const NonEmpty = z.string().trim().min(1);
const Identifier = z.string().regex(/^[a-z][a-z0-9_.:-]*$/);
const Severity = z.enum(['normal', 'borderline', 'abnormal', 'critical']);
const BandKind = z.enum([
  'stage',
  'risk',
  'likelihood',
  'severity',
  'screening',
  'class',
  'status',
]);

const MinMax = z
  .tuple([z.number().finite(), z.number().finite()])
  .refine(([lo, hi]) => lo <= hi, 'range lower bound must not exceed upper bound');

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const EvidenceSchema = z.strictObject({
  id: Identifier,
  type: z.enum(['derivation', 'validation', 'guideline', 'policy', 'review', 'reference']),
  citation: NonEmpty,
  locator: NonEmpty,
  doi: NonEmpty.optional(),
  url: z.string().url().optional(),
  reviewed: z.boolean(),
});

const EnumValueSchema = z.strictObject({
  value: NonEmpty,
  label: NonEmpty,
  description: NonEmpty,
  aliases: z.array(NonEmpty).optional(),
  points: z.number().finite().optional(),
  scorable: z.boolean().optional(),
  notTestableReason: NonEmpty.optional(),
});

const QuantitySchema = z.strictObject({
  analyte: Identifier,
  canonicalUnit: NonEmpty,
  acceptedUnits: z.array(NonEmpty).nonempty().refine(unique, 'accepted units must be unique'),
});

const ObservationMetadataSchema = z.strictObject({
  phase: z.enum(['admission', 'follow_up']),
  timestampField: Identifier,
  derivation: z.enum(['threshold', 'change_from_baseline']),
  baselineField: Identifier.optional(),
}).superRefine((observation, ctx) => {
  if ((observation.derivation === 'change_from_baseline') !== (observation.baselineField !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['baselineField'],
      message: 'change_from_baseline observations require a baselineField, and threshold observations must omit it',
    });
  }
});

const InputCommon = {
  title: NonEmpty,
  description: NonEmpty,
  conceptId: Identifier,
  sharedKey: Identifier.optional(),
  required: z.boolean(),
  examples: z.array(z.unknown()).nonempty(),
  sourceRefs: z.array(Identifier).nonempty().refine(unique, 'source references must be unique'),
  aliases: z.array(NonEmpty).refine(unique, 'aliases must be unique').optional(),
  deprecated: z.boolean().optional(),
};

const NumericCommon = {
  ...InputCommon,
  plausible: MinMax.optional(),
  hardLimits: MinMax.optional(),
  observation: ObservationMetadataSchema.optional(),
};

const NumberInputSchema = z.strictObject({
  ...NumericCommon,
  kind: z.literal('number'),
  default: z.number().finite().optional(),
  enumValues: z.never().optional(),
  quantity: z.never().optional(),
});

const IntegerInputSchema = z.strictObject({
  ...NumericCommon,
  kind: z.literal('integer'),
  default: z.number().int().finite().optional(),
  enumValues: z.never().optional(),
  quantity: z.never().optional(),
});

const BooleanInputSchema = z.strictObject({
  ...InputCommon,
  kind: z.literal('boolean'),
  default: z.boolean().optional(),
  plausible: z.never().optional(),
  hardLimits: z.never().optional(),
  enumValues: z.never().optional(),
  quantity: z.never().optional(),
});

const EnumInputSchema = z.strictObject({
  ...InputCommon,
  kind: z.literal('enum'),
  enumValues: z.array(EnumValueSchema).nonempty(),
  default: NonEmpty.optional(),
  plausible: z.never().optional(),
  hardLimits: z.never().optional(),
  quantity: z.never().optional(),
});

const QuantityInputSchema = z.strictObject({
  ...NumericCommon,
  kind: z.literal('quantity'),
  quantity: QuantitySchema,
  default: z.number().finite().optional(),
  enumValues: z.never().optional(),
});

const InputSpecSchema = z
  .discriminatedUnion('kind', [
    NumberInputSchema,
    IntegerInputSchema,
    BooleanInputSchema,
    EnumInputSchema,
    QuantityInputSchema,
  ])
  .superRefine((input, ctx) => {
    if (
      'plausible' in input &&
      input.plausible !== undefined &&
      input.hardLimits !== undefined &&
      (input.plausible[0] < input.hardLimits[0] || input.plausible[1] > input.hardLimits[1])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['plausible'],
        message: 'plausible range must be within hardLimits',
      });
    }
    if (
      'default' in input &&
      typeof input.default === 'number' &&
      'hardLimits' in input &&
      input.hardLimits !== undefined &&
      (input.default < input.hardLimits[0] || input.default > input.hardLimits[1])
    ) {
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'default must be within hardLimits' });
    }
    if (input.kind === 'enum') {
      const values = input.enumValues.map((entry) => entry.value);
      if (!unique(values)) {
        ctx.addIssue({ code: 'custom', path: ['enumValues'], message: 'enum values must be unique' });
      }
      const aliases = input.enumValues.flatMap((entry) => entry.aliases ?? []);
      if (!unique([...values, ...aliases])) {
        ctx.addIssue({ code: 'custom', path: ['enumValues'], message: 'enum values and aliases must not collide' });
      }
      const scoringOptions = input.enumValues.filter(
        (entry) => entry.points !== undefined || entry.scorable !== undefined || entry.notTestableReason !== undefined,
      );
      if (scoringOptions.length > 0 && scoringOptions.length !== input.enumValues.length) {
        ctx.addIssue({ code: 'custom', path: ['enumValues'], message: 'scoring metadata must be present on all options or none' });
      }
      for (const [index, entry] of input.enumValues.entries()) {
        if (entry.scorable === false) {
          if (entry.points !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['enumValues', index, 'points'], message: 'not-testable options must not declare points' });
          }
          if (entry.notTestableReason === undefined) {
            ctx.addIssue({ code: 'custom', path: ['enumValues', index, 'notTestableReason'], message: 'not-testable options require a reason' });
          }
        } else if (scoringOptions.length > 0 && entry.points === undefined) {
          ctx.addIssue({ code: 'custom', path: ['enumValues', index, 'points'], message: 'scorable options require points' });
        }
        if (entry.scorable !== false && entry.notTestableReason !== undefined) {
          ctx.addIssue({ code: 'custom', path: ['enumValues', index, 'notTestableReason'], message: 'only not-testable options may declare a reason' });
        }
      }
      if (input.default !== undefined && !values.includes(input.default)) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: 'default must be a declared enum value' });
      }
    }
  });

const AvailabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('always') }),
  z.strictObject({ kind: z.literal('whenAnyInputPresent'), fields: z.array(Identifier).nonempty().refine(unique) }),
  z.strictObject({ kind: z.literal('whenAllInputsPresent'), fields: z.array(Identifier).nonempty().refine(unique) }),
  z.strictObject({ kind: z.literal('computeCondition'), conditionId: Identifier }),
]);

const BandSchema = z.strictObject({
  code: Identifier,
  kind: BandKind,
  when: NonEmpty,
  label: NonEmpty,
  severity: Severity,
  evidenceRefs: z.array(Identifier).nonempty().refine(unique),
  where: z
    .array(z.strictObject({ field: Identifier, when: NonEmpty }))
    .nonempty()
    .optional(),
});

const OutputCommon = {
  title: NonEmpty,
  description: NonEmpty,
  availability: AvailabilitySchema,
  evidenceRefs: z.array(Identifier).nonempty().refine(unique),
  interpretationBands: z.array(BandSchema).nonempty().optional(),
};

const OutputSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...OutputCommon, kind: z.literal('number'), unit: NonEmpty.optional(), range: MinMax.optional() }),
  z.strictObject({ ...OutputCommon, kind: z.literal('integer'), unit: NonEmpty.optional(), range: MinMax.optional() }),
  z.strictObject({ ...OutputCommon, kind: z.literal('boolean'), unit: z.never().optional() }),
  z.strictObject({ ...OutputCommon, kind: z.literal('string'), unit: z.never().optional() }),
  z.strictObject({ ...OutputCommon, kind: z.literal('enum'), allowedValues: z.array(NonEmpty).nonempty().refine(unique), unit: z.never().optional() }),
  z.strictObject({ ...OutputCommon, kind: z.literal('string_list'), unit: z.never().optional() }),
  z.strictObject({ ...OutputCommon, kind: z.literal('number_list'), unit: NonEmpty.optional(), itemRange: MinMax.optional() }),
  z.strictObject({ ...OutputCommon, kind: z.literal('number_range'), unit: NonEmpty.optional(), range: MinMax.optional() }),
  z.strictObject({ ...OutputCommon, kind: z.literal('criterion_list'), unit: z.never().optional() }),
]);

const ConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('compare'),
    left: Identifier,
    operator: z.enum(['<', '<=', '>', '>=', '==', '!=']),
    right: Identifier,
    message: NonEmpty,
  }),
  z.strictObject({ kind: z.literal('atLeastOne'), fields: z.array(Identifier).min(2).refine(unique), message: NonEmpty }),
  z.strictObject({ kind: z.literal('requiredWhen'), field: Identifier, when: NonEmpty, required: z.array(Identifier).nonempty().refine(unique), message: NonEmpty }),
  z.strictObject({
    kind: z.literal('requireValueWhen'),
    field: Identifier,
    when: NonEmpty,
    where: z.array(z.strictObject({ field: Identifier, when: NonEmpty })).nonempty().optional(),
    target: Identifier,
    value: z.union([z.number().finite(), z.string(), z.boolean()]),
    message: NonEmpty,
  }),
  z.strictObject({
    kind: z.literal('forbidValueWhen'),
    field: Identifier,
    when: NonEmpty,
    where: z.array(z.strictObject({ field: Identifier, when: NonEmpty })).nonempty().optional(),
    target: Identifier,
    value: z.union([z.number().finite(), z.string(), z.boolean()]),
    message: NonEmpty,
  }),
  z.strictObject({
    kind: z.literal('requireAtLeastValuesWhen'),
    field: Identifier,
    when: NonEmpty,
    targets: z.array(z.strictObject({
      field: Identifier,
      value: z.union([z.number().finite(), z.string(), z.boolean()]),
    })).nonempty(),
    minimum: z.number().int().positive().optional(),
    message: NonEmpty,
  }),
  z.strictObject({
    kind: z.literal('forbidPresentWhen'),
    field: Identifier,
    when: NonEmpty,
    forbidden: z.array(Identifier).nonempty().refine(unique),
    message: NonEmpty,
  }),
]);

const WarningRuleSchema = z.strictObject({
  field: Identifier,
  when: NonEmpty,
  where: z.array(z.strictObject({ field: Identifier, when: NonEmpty })).nonempty().optional(),
  message: NonEmpty,
  evidenceRefs: z.array(Identifier).nonempty().refine(unique),
  adjustmentId: Identifier.optional(),
});

const PromptSchema = z.strictObject({ template: NonEmpty, description: NonEmpty });

const ClinicalModelCommon = {
  modelId: Identifier,
  modelVersion: NonEmpty,
  jurisdiction: NonEmpty.optional(),
  evidenceRefs: z.array(Identifier).nonempty().refine(unique),
};
const ClinicalModelSchema = z.discriminatedUnion('modelKind', [
  z.strictObject({
    ...ClinicalModelCommon,
    modelKind: z.literal('lookup'),
    dataSnapshot: NonEmpty,
    effectiveDate: z.iso.date().optional(),
    reviewDate: z.iso.date(),
  }),
  z.strictObject({
    ...ClinicalModelCommon,
    modelKind: z.enum(['formula', 'score', 'decision_tree', 'policy']),
    dataSnapshot: NonEmpty.optional(),
    effectiveDate: z.iso.date().optional(),
    reviewDate: z.iso.date().optional(),
  }),
]);

const ApplicabilitySchema = z.strictObject({
  population: NonEmpty,
  setting: NonEmpty,
  exclusions: z.array(NonEmpty),
  evidenceRefs: z.array(Identifier).nonempty().refine(unique),
});

const ScoringComponentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('enum'), field: Identifier }),
  z.strictObject({ kind: z.literal('boolean'), field: Identifier, truePoints: z.number().finite(), falsePoints: z.number().finite() }),
  z.strictObject({
    kind: z.literal('threshold'),
    field: Identifier,
    operator: z.enum(['gte', 'lte']),
    threshold: z.number().finite(),
    truePoints: z.number().finite(),
    falsePoints: z.number().finite(),
  }),
]);

const ScoringSchema = z.strictObject({
  output: Identifier,
  components: z.array(ScoringComponentSchema).nonempty(),
  range: MinMax,
  evidenceRefs: z.array(Identifier).nonempty().refine(unique),
}).superRefine((scoring, ctx) => {
  const fields = scoring.components.map((component) => component.field);
  if (!unique(fields)) {
    ctx.addIssue({ code: 'custom', path: ['components'], message: 'scoring component fields must be unique' });
  }
});

const CompletionSchema = z.strictObject({
  completeOutput: Identifier,
  missingReasonsOutput: Identifier,
});

const AdjustmentConditionSchema = z.strictObject({
  kind: z.literal('inputEquals'),
  field: Identifier,
  value: z.union([z.string(), z.number().finite(), z.boolean()]),
});
const AdjustmentTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('input'), field: Identifier }),
  z.strictObject({ kind: z.literal('output'), field: Identifier }),
]);
const AdjustmentCommon = {
  id: Identifier,
  target: AdjustmentTargetSchema,
  condition: AdjustmentConditionSchema.optional(),
  verifyOutput: Identifier.optional(),
  verifyTolerance: z.number().finite().nonnegative().optional(),
  appliedOutput: Identifier.optional(),
  evidenceRefs: z.array(Identifier).nonempty().refine(unique),
};
const AdjustmentSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...AdjustmentCommon, operation: z.literal('cap'), maximum: z.number().finite() }),
  z.strictObject({ ...AdjustmentCommon, operation: z.literal('floor'), minimum: z.number().finite() }),
  z.strictObject({ ...AdjustmentCommon, operation: z.literal('clamp'), minimum: z.number().finite(), maximum: z.number().finite() }),
]);

const NonEmptyRecord = <T extends z.ZodType>(value: T) =>
  z.record(z.string(), value).refine((record) => Object.keys(record).length > 0, 'record must not be empty');

export const SpecSchema = z
  .strictObject({
    id: Identifier,
    version: NonEmpty,
    name: NonEmpty,
    family: Identifier.optional(),
    variant: Identifier.optional(),
    supersedes: z.array(Identifier).refine(unique).optional(),
    supersededBy: z.array(Identifier).refine(unique).optional(),
    synonyms: z.array(NonEmpty).refine(unique).optional(),
    abbreviations: z.array(NonEmpty).refine(unique).optional(),
    reviewAfter: z.iso.date().optional(),
    clinicalModel: ClinicalModelSchema,
    applicability: ApplicabilitySchema,
    purposeForAgents: NonEmpty,
    whenNotToUse: NonEmpty.optional(),
    evidence: z.array(EvidenceSchema).nonempty(),
    inputs: NonEmptyRecord(InputSpecSchema),
    outputs: NonEmptyRecord(OutputSpecSchema),
    primaryOutputs: z.array(Identifier).nonempty().refine(unique),
    interpretationBands: z.array(BandSchema).nonempty().optional(),
    constraints: z.array(ConstraintSchema).optional(),
    warnings: z.array(WarningRuleSchema).optional(),
    scoring: ScoringSchema.optional(),
    completion: CompletionSchema.optional(),
    adjustments: z.array(AdjustmentSchema).nonempty().optional(),
    prompt: PromptSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    for (const output of spec.primaryOutputs) {
      if (!Object.hasOwn(spec.outputs, output)) {
        ctx.addIssue({ code: 'custom', path: ['primaryOutputs'], message: `unknown primary output '${output}'` });
      }
    }
    if (spec.completion !== undefined) {
      const completeOutput = spec.outputs[spec.completion.completeOutput];
      if (completeOutput?.kind !== 'boolean') {
        ctx.addIssue({
          code: 'custom',
          path: ['completion', 'completeOutput'],
          message: 'completion completeOutput must reference a boolean output',
        });
      }
      const missingReasonsOutput = spec.outputs[spec.completion.missingReasonsOutput];
      if (missingReasonsOutput?.kind !== 'string_list') {
        ctx.addIssue({
          code: 'custom',
          path: ['completion', 'missingReasonsOutput'],
          message: 'completion missingReasonsOutput must reference a string_list output',
        });
      }
    }
  });

export type CalcSpec = z.infer<typeof SpecSchema>;
export type InputSpec = z.infer<typeof InputSpecSchema>;
export type OutputSpec = z.infer<typeof OutputSpecSchema>;
export type OutputAvailability = z.infer<typeof AvailabilitySchema>;
export type Band = z.infer<typeof BandSchema>;
