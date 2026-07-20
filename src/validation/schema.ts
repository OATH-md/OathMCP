import * as z from 'zod/v4';
import { ENGINE_ERROR_CODES } from '../engine/errors.js';

const Id = z.string().min(1).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const DateString = z.iso.date();
const DateTimeString = z.iso.datetime({ offset: true });

export const REVIEW_GROUPS = [
  'formula_unit_dosing',
  'additive_criteria_scores',
  'policy_versioned',
  'interpreter_conditional',
] as const;

export const ReviewGroupSchema = z.enum(REVIEW_GROUPS);
export const ReviewStateNameSchema = z.enum([
  'pending',
  'blocked',
  'stale',
  'search_complete',
  'source_verified',
  'scenario_verified',
]);
export const ClaimStatusSchema = z.enum([
  'supported',
  'variant_specific',
  'conflicted',
  'unsupported',
  'superseded',
]);
export const CaseStatusSchema = z.enum(['pending', 'passed', 'failed', 'blocked']);
export const SourceRoleSchema = z.enum([
  'bibliographic_database',
  'derivation',
  'external_validation',
  'controlling_authority',
  'specialty_guidance',
  'approved_label',
  'independent_numeric',
  'systematic_review',
  'data_release',
  'discovery_only',
]);

export const RequiredSourceBundleSchema = z.strictObject({
  roles: z.array(SourceRoleSchema),
  minimumExternalValidations: z.number().int().nonnegative(),
  controllingAuthorityRequired: z.boolean(),
});

export const ReviewIssueSchema = z.strictObject({
  code: Id,
  message: z.string().min(1),
  severity: z.enum(['error', 'warning']).default('error'),
  gate: z.enum(['integrity', 'source', 'scenario', 'release']).optional(),
  calculatorId: Id.optional(),
  path: z.string().min(1).optional(),
});

export const ToleranceSchema = z
  .strictObject({
    mode: z.enum(['absolute', 'relative', 'exact']),
    value: z.number().nonnegative().finite().optional(),
    rationale: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== 'exact' && value.value === undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'numeric tolerance requires value' });
    }
    if (value.mode === 'exact' && value.value !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'exact tolerance cannot declare value' });
    }
  });

export const SearchSourceSchema = z
  .strictObject({
    id: Id,
    sourceRole: SourceRoleSchema,
    authorityId: Id,
    database: z.string().min(1),
    site: z.string().min(1),
    interface: z.string().min(1),
    exactQuery: z.string().min(1),
    translationExposed: z.boolean(),
    translatedQuery: z.string().min(1).optional(),
    filters: z.array(z.string().min(1)),
    coverageFrom: DateString.optional(),
    coverageTo: DateString,
    searchedAt: DateString,
    reviewer: z.string().min(1),
    recordsRetrieved: z.number().int().nonnegative(),
    exportDigest: z.string().min(1).optional(),
    stableCitationIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((source, ctx) => {
    if (source.translationExposed !== (source.translatedQuery !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['translatedQuery'],
        message: 'translatedQuery is required only when the interface exposes it',
      });
    }
    if (source.exportDigest === undefined && (source.stableCitationIds?.length ?? 0) === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['exportDigest'],
        message: 'record a result-export digest or stable citation IDs',
      });
    }
  });

export const SearchQualityReviewSchema = z.strictObject({
  method: z.literal('PRESS-derived'),
  initialMedlineSourceId: Id,
  checklist: z.array(z.string().min(1)).min(1),
  comments: z.array(z.string().min(1)),
  resolution: z.string().min(1),
  resolved: z.boolean(),
  reviewer: z.string().min(1),
  reviewedAt: DateString,
});

export const ScreenedCitationSchema = z.strictObject({
  citationId: Id,
  title: z.string().min(1),
  disposition: z.enum(['included', 'excluded']),
  exclusionReason: z.string().min(1).optional(),
  fullTextAssessed: z.boolean(),
}).superRefine((citation, ctx) => {
  if (citation.disposition === 'excluded' && citation.exclusionReason === undefined) {
    ctx.addIssue({ code: 'custom', path: ['exclusionReason'], message: 'excluded citations require a reason' });
  }
});

export const LiteratureSearchRecordSchema = z.strictObject({
  id: Id,
  calculatorId: Id,
  model: z.string().min(1),
  variant: z.string().min(1),
  searchedAt: DateString,
  reviewBy: DateString,
  sources: z.array(SearchSourceSchema).min(1),
  accounting: z.strictObject({
    retrieved: z.number().int().nonnegative(),
    deduplicated: z.number().int().nonnegative(),
    screened: z.number().int().nonnegative(),
    fullTextAssessed: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    included: z.number().int().nonnegative(),
  }),
  deduplication: z.strictObject({
    method: z.string().min(1),
    tool: z.string().min(1),
    version: z.string().min(1),
  }),
  screenedCitations: z.array(ScreenedCitationSchema),
  citationChasing: z.strictObject({ backward: z.boolean(), forward: z.boolean() }),
  checks: z.strictObject({
    corrections: z.boolean(),
    retractions: z.boolean(),
    supersession: z.boolean(),
  }),
  qualityReview: SearchQualityReviewSchema,
}).superRefine((record, ctx) => {
  if (new Set(record.sources.map((source) => source.id)).size !== record.sources.length) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'search source IDs must be unique' });
  }
  if (new Set(record.screenedCitations.map((citation) => citation.citationId)).size !== record.screenedCitations.length) {
    ctx.addIssue({ code: 'custom', path: ['screenedCitations'], message: 'screened citation IDs must be unique' });
  }
  if (record.reviewBy < record.searchedAt) {
    ctx.addIssue({ code: 'custom', path: ['reviewBy'], message: 'reviewBy cannot precede searchedAt' });
  }
});

export const AuthoritySourceSchema = z.strictObject({
  id: Id,
  name: z.string().min(1),
  sourceRole: SourceRoleSchema,
  owner: z.string().min(1),
  jurisdiction: z.string().min(1),
  controllingClaimScope: z.array(z.string().min(1)).min(1),
  approvalStatus: z.string().min(1),
  versionMethod: z.string().min(1),
  currentnessMethod: z.string().min(1),
  version: z.string().min(1),
  checkedAt: DateString,
  reviewBy: DateString,
  discoveryOnly: z.boolean(),
  url: z.string().url(),
}).superRefine((source, ctx) => {
  if (source.reviewBy < source.checkedAt) {
    ctx.addIssue({ code: 'custom', path: ['reviewBy'], message: 'reviewBy cannot precede checkedAt' });
  }
});

export const EvidenceLocatorSchema = z.strictObject({
  sourceId: Id,
  locator: z.string().min(1),
  excerptDigest: z.string().min(1).optional(),
});

export const ClinicalClaimSchema = z.strictObject({
  id: Id,
  scope: z.enum(['clinical', 'compatibility']).default('clinical'),
  kind: z.enum([
    'formula', 'coefficient', 'input', 'unit', 'default', 'cap', 'cutoff', 'band',
    'outcome', 'applicability', 'exclusion', 'warning', 'interpretation', 'recommendation',
  ]),
  statement: z.string().min(1),
  covers: z.array(z.string().min(1)).length(1),
  status: ClaimStatusSchema,
  sourceIds: z.array(Id),
  locators: z.array(EvidenceLocatorSchema),
  executable: z.boolean(),
  scenarioIds: z.array(Id),
  nonExecutableRationale: z.string().min(1).optional(),
  compatibilityDecision: z.strictObject({
    oldBehavior: z.string().min(1),
    replacement: z.string().min(1),
    rationale: z.string().min(1),
  }).optional(),
  reviewedAt: DateString.optional(),
  reviewBy: DateString.optional(),
}).superRefine((claim, ctx) => {
  if (claim.scope === 'compatibility' && !claim.covers[0]?.startsWith('compatibility:')) {
    ctx.addIssue({ code: 'custom', path: ['covers'], message: 'compatibility claims must cover a compatibility surface' });
  }
  if (claim.scope === 'compatibility' && (claim.executable || claim.sourceIds.length > 0 || claim.locators.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'compatibility claims are decision records, not executable clinical evidence claims' });
  }
  if (claim.scope === 'compatibility' && claim.compatibilityDecision === undefined) {
    ctx.addIssue({ code: 'custom', path: ['compatibilityDecision'], message: 'compatibility claims require the exact reviewed old behavior, replacement, and rationale' });
  }
  if (claim.scope === 'clinical' && claim.compatibilityDecision !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['compatibilityDecision'], message: 'clinical claims cannot carry compatibility decision metadata' });
  }
  if (claim.executable && claim.scenarioIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['scenarioIds'], message: 'executable claims require a scenario witness' });
  }
  if (!claim.executable && claim.nonExecutableRationale === undefined) {
    ctx.addIssue({ code: 'custom', path: ['nonExecutableRationale'], message: 'non-executable claims require a rationale' });
  }
  if (['supported', 'variant_specific'].includes(claim.status) &&
      (claim.reviewedAt === undefined || claim.reviewBy === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['reviewBy'], message: 'supported claims require reviewedAt and reviewBy' });
  }
});

/**
 * A compatibility exception must link two distinct dossier records: the
 * reviewed product decision and the independently sourced clinical reason.
 * Keeping the link shape here makes it impossible for callers to collapse the
 * evidence-free compatibility decision into the clinical evidence claim.
 */
export const CompatibilityClaimLinkSchema = z.strictObject({
  compatibilityClaimId: Id,
  clinicalClaimId: Id,
}).refine(({ compatibilityClaimId, clinicalClaimId }) => compatibilityClaimId !== clinicalClaimId, {
  message: 'compatibility and clinical claim links must be distinct',
  path: ['clinicalClaimId'],
});

const ExpectedErrorSchema = z.strictObject({
  code: z.enum(ENGINE_ERROR_CODES),
  field: z.string().min(1),
  messageIncludes: z.string().min(1).optional(),
});

const ExpectedInterpretationSchema = z.strictObject({
  output: z.string().min(1),
  code: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  severity: z.string().min(1),
});

const ValidationCaseBase = z.strictObject({
  id: Id,
  tags: z.array(z.string().min(1)).min(1),
  inputs: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()),
  expectedBehavior: z.enum(['calculate', 'warn', 'clarify', 'reject', 'omit']),
  expectedWarnings: z.array(z.string().min(1)).optional(),
  expectedInterpretations: z.array(ExpectedInterpretationSchema).min(1).optional(),
  expectedError: ExpectedErrorSchema.optional(),
  omittedOutputs: z.array(z.string().min(1)).optional(),
  tolerance: ToleranceSchema,
  claimIds: z.array(Id).min(1),
  sourceIds: z.array(Id).min(1),
  witnesses: z.array(z.string().min(1)).min(1),
}).superRefine((testCase, ctx) => {
  if (['calculate', 'warn', 'omit'].includes(testCase.expectedBehavior) && Object.keys(testCase.expected).length === 0) {
    ctx.addIssue({ code: 'custom', path: ['expected'], message: 'successful cases require expected outputs' });
  }
  if (testCase.expectedBehavior === 'warn' && (testCase.expectedWarnings?.length ?? 0) === 0) {
    ctx.addIssue({ code: 'custom', path: ['expectedWarnings'], message: 'warn cases require expected warning text' });
  }
  if (testCase.expectedBehavior !== 'warn' && testCase.expectedWarnings !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['expectedWarnings'], message: 'only warn cases may declare expected warnings' });
  }
  if (['reject', 'clarify'].includes(testCase.expectedBehavior) && testCase.expectedError === undefined) {
    ctx.addIssue({ code: 'custom', path: ['expectedError'], message: 'reject/clarify cases require an error discriminant' });
  }
  const clarificationCodes = ['MISSING_REQUIRED', 'AMBIGUOUS_ALIAS'];
  if (testCase.expectedBehavior === 'clarify' && testCase.expectedError !== undefined &&
      !clarificationCodes.includes(testCase.expectedError.code)) {
    ctx.addIssue({ code: 'custom', path: ['expectedError', 'code'], message: 'clarify cases require a clarification-class error code' });
  }
  if (testCase.expectedBehavior === 'reject' && testCase.expectedError !== undefined &&
      clarificationCodes.includes(testCase.expectedError.code)) {
    ctx.addIssue({ code: 'custom', path: ['expectedError', 'code'], message: 'rejection cannot use a clarification-class error code' });
  }
  if (testCase.expectedBehavior === 'omit' && (testCase.omittedOutputs?.length ?? 0) === 0) {
    ctx.addIssue({ code: 'custom', path: ['omittedOutputs'], message: 'omit cases require output names' });
  }
});

export const ReferenceCaseSchema = ValidationCaseBase.extend({ kind: z.literal('reference') });
export const EdgeCaseSchema = ValidationCaseBase.extend({ kind: z.literal('edge') });
export const AgentScenarioSchema = ValidationCaseBase.extend({ kind: z.literal('agent') });
export const ValidationCaseSchema = z.discriminatedUnion('kind', [
  ReferenceCaseSchema,
  EdgeCaseSchema,
  AgentScenarioSchema,
]);

export const ValidationDossierSchema = z.strictObject({
  calculatorId: Id,
  specVersion: z.string().min(1),
  clinicalModel: z.string().min(1),
  variant: z.string().min(1),
  population: z.string().min(1),
  setting: z.string().min(1),
  assessmentTiming: z.string().min(1),
  endpoint: z.string().min(1),
  reviewGroup: ReviewGroupSchema,
  enrollment: z.literal('pending_independent_review'),
  searchRecords: z.array(LiteratureSearchRecordSchema),
  authoritySourceIds: z.array(Id),
  claims: z.array(ClinicalClaimSchema),
  cases: z.array(ValidationCaseSchema),
  compatibilityNotes: z.array(z.string().min(1)).default([]),
  explicitBlockers: z.array(ReviewIssueSchema),
}).superRefine((dossier, ctx) => {
  const unique = (values: string[], path: string): void => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: 'custom', path: [path], message: `${path} values must be unique` });
    }
  };
  unique(dossier.searchRecords.map((record) => record.id), 'searchRecords');
  unique(dossier.authoritySourceIds, 'authoritySourceIds');
  unique(dossier.claims.map((claim) => claim.id), 'claims');
  unique(dossier.cases.map((testCase) => testCase.id), 'cases');
  dossier.claims.forEach((claim, index) => {
    unique(claim.sourceIds, `claims.${index}.sourceIds`);
    unique(claim.scenarioIds, `claims.${index}.scenarioIds`);
    unique(claim.covers, `claims.${index}.covers`);
  });
  dossier.cases.forEach((testCase, index) => {
    unique(testCase.claimIds, `cases.${index}.claimIds`);
    unique(testCase.sourceIds, `cases.${index}.sourceIds`);
    unique(testCase.tags, `cases.${index}.tags`);
    unique(testCase.witnesses, `cases.${index}.witnesses`);
  });
});

export const ValidationCatalogSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  generatedAt: DateString,
  sourcePolicies: z.strictObject({
    formula_unit_dosing: RequiredSourceBundleSchema,
    additive_criteria_scores: RequiredSourceBundleSchema,
    policy_versioned: RequiredSourceBundleSchema,
    interpreter_conditional: RequiredSourceBundleSchema,
  }),
  calculatorSourcePolicyOverrides: z.record(Id, RequiredSourceBundleSchema),
  groups: z.array(z.strictObject({
    id: ReviewGroupSchema,
    label: z.string().min(1),
    calculatorIds: z.array(Id).min(1),
  })).length(4),
}).superRefine((catalog, ctx) => {
  if (new Set(catalog.groups.map((group) => group.id)).size !== REVIEW_GROUPS.length) {
    ctx.addIssue({ code: 'custom', path: ['groups'], message: 'each review group must appear exactly once' });
  }
});

export const ReleaseEvidenceAttestationSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  packageVersion: z.string().min(1),
  checkedAt: DateString,
  networkCheckedAt: DateString,
  reviewer: z.string().min(1),
  reviewerTimeZone: z.string().min(1).default('UTC'),
  currentnessConfirmed: z.boolean(),
  unresolvedChanges: z.array(z.string().min(1)),
  calculatorIds: z.array(Id).min(1),
  sourceVersions: z.record(z.string(), z.string().min(1)),
}).superRefine((attestation, ctx) => {
  if (new Set(attestation.calculatorIds).size !== attestation.calculatorIds.length) {
    ctx.addIssue({ code: 'custom', path: ['calculatorIds'], message: 'calculatorIds must be unique' });
  }
});

export const ReviewStateSchema = z.strictObject({
  state: ReviewStateNameSchema,
  derivedAt: DateTimeString,
  blockers: z.array(ReviewIssueSchema),
  staleSourceIds: z.array(Id),
  counts: z.strictObject({
    claimsTotal: z.number().int().nonnegative(),
    claimsSupported: z.number().int().nonnegative(),
    requiredCases: z.number().int().nonnegative(),
    passedCases: z.number().int().nonnegative(),
    executableClaims: z.number().int().nonnegative(),
    witnessedExecutableClaims: z.number().int().nonnegative(),
  }),
});

export type ValidationCatalog = z.infer<typeof ValidationCatalogSchema>;
export type ReviewGroup = z.infer<typeof ReviewGroupSchema>;
export type ValidationDossier = z.infer<typeof ValidationDossierSchema>;
export type LiteratureSearchRecord = z.infer<typeof LiteratureSearchRecordSchema>;
export type AuthoritySource = z.infer<typeof AuthoritySourceSchema>;
export type ReferenceCase = z.infer<typeof ReferenceCaseSchema>;
export type ValidationCase = z.infer<typeof ValidationCaseSchema>;
export type ReleaseEvidenceAttestation = z.infer<typeof ReleaseEvidenceAttestationSchema>;
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type CaseStatus = z.infer<typeof CaseStatusSchema>;
export type SourceRole = z.infer<typeof SourceRoleSchema>;
export type CalculatorId = string;
export type GenericCaseTag =
  | 'required-inputs'
  | 'hard-limits'
  | 'plausibility'
  | 'defaults'
  | 'aliases'
  | 'unit-equivalence'
  | 'interpretation-boundaries'
  | 'constraints'
  | 'conditional-output'
  | 'agent-applicability';
export type CalculatorSpecificCaseTag = `calculator:${string}:${string}`;
export type CaseTag = GenericCaseTag | CalculatorSpecificCaseTag;
export interface RequiredSourceBundle {
  roles: SourceRole[];
  minimumExternalValidations: number;
  controllingAuthorityRequired: boolean;
}
export interface CaseExecutionResult {
  caseId: string;
  status: Exclude<CaseStatus, 'pending'>;
  enginePassed: boolean;
  fullMcpPassed: boolean;
  compactMcpPassed: boolean;
  parityPassed: boolean;
  issues: ReviewIssue[];
}
export interface ValidationCaseRunner {
  runEngine(calculatorId: CalculatorId, inputs: Record<string, unknown>): Promise<unknown>;
  runFullMcp(calculatorId: CalculatorId, inputs: Record<string, unknown>): Promise<unknown>;
  runCompactMcp(calculatorId: CalculatorId, inputs: Record<string, unknown>): Promise<unknown>;
}
export interface CalculatorValidationReport {
  calculatorId: CalculatorId;
  reviewState: ReviewState;
  issues: ReviewIssue[];
}
export interface ReviewGroupValidationReport {
  groupId: ReviewGroup;
  state: ReviewState['state'];
  calculatorIds: string[];
  missingCalculatorIds: string[];
  memberStateCounts: Record<ReviewState['state'], number>;
}
export interface ValidationReport {
  ok: boolean;
  requestedGate: 'integrity' | 'source' | 'scenario' | 'release';
  calculatorReports: CalculatorValidationReport[];
  groupReports: ReviewGroupValidationReport[];
  errors: ReviewIssue[];
  warnings: ReviewIssue[];
}
