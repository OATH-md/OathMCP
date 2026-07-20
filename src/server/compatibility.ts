import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { ENGINE_ERROR_CODES, loadSpecs } from '../engine/index.js';
import { loadAuthoritativeReferenceCases, loadValidationDossiers } from '../validation/load-validation.js';
import {
  CompatibilityClaimLinkSchema,
  type ValidationDossier,
} from '../validation/schema.js';
import { catalogMode, type CatalogMode } from './build-tools.js';
import { connectInMemoryClient } from './in-memory-client.js';
import { buildCalculatorCompatibilityContract } from './public-contract.js';

const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const SafetyBreakSchema = CompatibilityClaimLinkSchema.safeExtend({
  id: z.string().min(1),
  calculatorId: z.string().min(1),
  clinicalClaimCoverage: z.string().min(1),
  surface: z.string().min(1),
  oldBehavior: z.string().min(1),
  replacement: z.string().min(1),
  rationale: z.string().min(1),
  oldValueDigest: Sha256Schema,
  replacementValueDigest: Sha256Schema,
});

const InputContractSchema = z.strictObject({
  required: z.boolean(),
  kind: z.enum(['number', 'integer', 'boolean', 'enum', 'quantity']),
  enumValues: z.array(z.string()).optional(),
  enumAliases: z.record(z.string(), z.array(z.string())).optional(),
  quantity: z.strictObject({
    canonicalUnit: z.string(),
    acceptedUnits: z.array(z.string()),
  }).optional(),
  default: z.union([z.number(), z.string(), z.boolean()]).optional(),
});

const ConstraintValueSchema = z.union([z.number(), z.string(), z.boolean()]);
const ConstraintWhereSchema = z.array(z.strictObject({ field: z.string(), when: z.string() })).min(1).optional();
const ConditionalRequirementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('requiredWithAliases'), fields: z.array(z.string()).min(2) }),
  z.strictObject({
    kind: z.literal('compare'), left: z.string(), operator: z.enum(['<', '<=', '>', '>=', '==', '!=']),
    right: z.string(), message: z.string(),
  }),
  z.strictObject({ kind: z.literal('atLeastOne'), fields: z.array(z.string()).min(2), message: z.string() }),
  z.strictObject({
    kind: z.literal('requiredWhen'),
    field: z.string(),
    when: z.string(),
    required: z.array(z.string()).min(1),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('requireValueWhen'), field: z.string(), when: z.string(), where: ConstraintWhereSchema,
    target: z.string(), value: ConstraintValueSchema, message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('forbidValueWhen'), field: z.string(), when: z.string(), where: ConstraintWhereSchema,
    target: z.string(), value: ConstraintValueSchema, message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('requireAtLeastValuesWhen'), field: z.string(), when: z.string(),
    targets: z.array(z.strictObject({ field: z.string(), value: ConstraintValueSchema })).min(1),
    minimum: z.number().int().positive().optional(), message: z.string(),
  }),
  z.strictObject({
    kind: z.literal('forbidPresentWhen'), field: z.string(), when: z.string(),
    forbidden: z.array(z.string()).min(1), message: z.string(),
  }),
]);

const OutputAvailabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('always') }),
  z.strictObject({ kind: z.literal('whenAnyInputPresent'), fields: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal('whenAllInputsPresent'), fields: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal('computeCondition'), conditionId: z.string() }),
]);

const OutputContractSchema = z.strictObject({
  kind: z.enum([
    'number', 'integer', 'boolean', 'string', 'enum', 'string_list', 'number_list',
    'number_range', 'criterion_list',
  ]),
  allowedValues: z.array(z.string()).optional(),
  unit: z.string().optional(),
  availability: OutputAvailabilitySchema,
});

const CalculatorContractSchema = z.strictObject({
  inputs: z.record(z.string(), InputContractSchema),
  conditionalRequirements: z.array(ConditionalRequirementSchema),
  outputs: z.record(z.string(), OutputContractSchema),
});

const CalculatorContractPairSchema = z.strictObject({
  directTool: CalculatorContractSchema,
  compactDispatcher: CalculatorContractSchema,
});

export const CompatibilitySnapshotSchema = z.strictObject({
  catalogMode: z.literal('full'),
  defaultCatalogMode: z.enum(['full', 'compact']),
  toolNames: z.array(z.string().min(1)),
  promptNames: z.array(z.string().min(1)),
  evidenceUris: z.array(z.string().min(1)),
  safeAliases: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
  calculatorContracts: z.record(z.string(), CalculatorContractPairSchema),
  resultEnvelopeFields: z.array(z.string().min(1)),
  responseForms: z.array(z.enum(['json_text', 'structuredContent'])),
  directToolAnnotations: z.strictObject({
    readOnlyHint: z.boolean(),
    idempotentHint: z.boolean(),
    openWorldHint: z.boolean(),
  }),
  errorDiscriminants: z.array(z.string().min(1)),
});

export const CompatibilityManifestSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  capturedAt: z.iso.date(),
  snapshot: CompatibilitySnapshotSchema,
  allowedSafetyBreaks: z.array(SafetyBreakSchema),
}).superRefine((manifest, ctx) => {
  if (new Set(manifest.allowedSafetyBreaks.map((entry) => entry.id)).size !== manifest.allowedSafetyBreaks.length) {
    ctx.addIssue({ code: 'custom', path: ['allowedSafetyBreaks'], message: 'safety-break IDs must be unique' });
  }
});

export type CompatibilitySnapshot = z.infer<typeof CompatibilitySnapshotSchema>;
export type CompatibilityManifest = z.infer<typeof CompatibilityManifestSchema>;
export interface CompatibilityReport { ok: boolean; differences: string[] }

export async function captureCompatibilitySnapshot(mode: CatalogMode): Promise<CompatibilitySnapshot> {
  if (mode !== 'full') throw new Error('the 1.0 compatibility baseline must be captured in full mode');
  const connection = await connectInMemoryClient('compatibility-snapshot', { mode });
  let defaultConnection: Awaited<ReturnType<typeof connectInMemoryClient>> | undefined;
  try {
    defaultConnection = await connectInMemoryClient('compatibility-default-snapshot');
    const client = connection.client;
    const [{ tools }, { prompts }, { resources }, defaultTools] = await Promise.all([
      client.listTools(), client.listPrompts(), client.listResources(), defaultConnection.client.listTools(),
    ]);
    const toolNames = tools.map((tool) => tool.name).sort();
    const defaultToolNames = defaultTools.tools.map((tool) => tool.name).sort();
    const inferredDefault: CatalogMode = JSON.stringify(defaultToolNames) === JSON.stringify(toolNames) ? 'full' : 'compact';
    if (inferredDefault !== catalogMode(undefined)) throw new Error('catalogMode() and buildServer() defaults disagree');
    const directTools = tools.filter((tool) => tool.name.startsWith('calculate_') && tool.name !== 'calculate_panel');
    const firstDirect = directTools[0];
    if (firstDirect === undefined) throw new Error('full catalog exposes no direct calculator tools');
    const annotationHints = (tool: typeof firstDirect) => ({
      readOnlyHint: tool.annotations?.readOnlyHint ?? false,
      idempotentHint: tool.annotations?.idempotentHint ?? false,
      openWorldHint: tool.annotations?.openWorldHint ?? true,
    });
    const annotations = directTools.map((tool) => JSON.stringify(annotationHints(tool)));
    if (new Set(annotations).size !== 1) throw new Error('direct-tool annotations are inconsistent');
    const resultEnvelopeFields = Object.keys(
      (firstDirect.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
    ).sort();
    const specs = loadSpecs();
    const sentinel = specs.values().next().value;
    if (sentinel === undefined) throw new Error('calculator catalog is empty');
    const sentinelCase = loadAuthoritativeReferenceCases(sentinel.id)
      .find((testCase) => ['calculate', 'warn', 'omit'].includes(testCase.expectedBehavior));
    if (sentinelCase === undefined) throw new Error(`${sentinel.id} has no successful authoritative reference case`);
    const response = await client.callTool({
      name: `calculate_${sentinel.id}`,
      arguments: sentinelCase.inputs,
    });
    const content = response.content as { type: string }[];
    const responseForms: ('json_text' | 'structuredContent')[] = [];
    if (content.some((entry) => entry.type === 'text')) responseForms.push('json_text');
    if (response.structuredContent !== undefined) responseForms.push('structuredContent');
    const aliases = Object.fromEntries([...specs].map(([id, spec]) => [
      id,
      Object.fromEntries(Object.entries(spec.inputs)
        .filter(([, input]) => (input.aliases?.length ?? 0) > 0)
        .map(([name, input]) => [name, [...(input.aliases ?? [])].sort()])),
    ]));
    const calculatorContracts = Object.fromEntries([...specs].map(([id, spec]) => {
      const contract = buildCalculatorCompatibilityContract(spec);
      return [id, {
        directTool: CalculatorContractSchema.parse(contract),
        compactDispatcher: CalculatorContractSchema.parse(structuredClone(contract)),
      }];
    }));
    return {
      catalogMode: mode,
      defaultCatalogMode: inferredDefault,
      toolNames,
      promptNames: prompts.map((prompt) => prompt.name).sort(),
      // The 1.0 manifest freezes calculator evidence resources specifically.
      // Global service resources (for example the additive Responsible Use
      // notice) are outside that historical calculator surface.
      evidenceUris: resources
        .map((resource) => resource.uri)
        .filter((uri) => uri.startsWith('calc://') && uri.endsWith('/evidence'))
        .sort(),
      safeAliases: aliases,
      calculatorContracts,
      resultEnvelopeFields,
      responseForms,
      directToolAnnotations: annotationHints(firstDirect),
      errorDiscriminants: [...ENGINE_ERROR_CODES].sort(),
    };
  } finally {
    await Promise.all([connection.close(), defaultConnection?.close()]);
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function valueDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function snapshotSurfaces(snapshot: CompatibilitySnapshot): Map<string, unknown> {
  const surfaces = new Map<string, unknown>();
  surfaces.set('catalogMode', snapshot.catalogMode);
  surfaces.set('defaultCatalogMode', snapshot.defaultCatalogMode);
  for (const key of ['toolNames', 'promptNames', 'evidenceUris', 'resultEnvelopeFields', 'responseForms', 'errorDiscriminants'] as const) {
    for (const value of snapshot[key]) surfaces.set(`${key}:${value}`, true);
  }
  for (const [calculatorId, inputs] of Object.entries(snapshot.safeAliases)) {
    for (const [input, aliases] of Object.entries(inputs)) {
      surfaces.set(`safeAliases:${calculatorId}.${input}`, aliases);
    }
  }
  for (const [calculatorId, contract] of Object.entries(snapshot.calculatorContracts)) {
    for (const consumer of ['directTool', 'compactDispatcher'] as const) {
      const prefix = `calculatorContracts:${calculatorId}.${consumer}`;
      surfaces.set(`${prefix}.inputs`, contract[consumer].inputs);
      surfaces.set(`${prefix}.conditionalRequirements`, contract[consumer].conditionalRequirements);
      for (const [outputName, output] of Object.entries(contract[consumer].outputs)) {
        surfaces.set(`${prefix}.outputs.${outputName}`, output);
      }
    }
  }
  for (const [key, value] of Object.entries(snapshot.directToolAnnotations)) {
    surfaces.set(`directToolAnnotations:${key}`, String(value));
  }
  return surfaces;
}

export function compatibilitySurfaceDigest(snapshot: CompatibilitySnapshot, surface: string): string {
  return valueDigest(snapshotSurfaces(snapshot).get(surface));
}

export function validateCompatibilitySnapshot(
  snapshot: CompatibilitySnapshot,
  manifest: CompatibilityManifest,
  dossiers?: ReadonlyMap<string, Pick<ValidationDossier, 'claims'>>,
): CompatibilityReport {
  const differences: string[] = [];
  const validBreaks = new Set<string>();
  const actual = snapshotSurfaces(snapshot);
  const expected = snapshotSurfaces(manifest.snapshot);
  // Loading every assurance dossier is the expensive part of compatibility
  // validation. Most mutation checks have no allowed safety breaks, so they
  // have no dossier links to validate and should not pay that I/O cost.
  const linkedDossiers = manifest.allowedSafetyBreaks.length > 0
    ? (dossiers ?? loadValidationDossiers())
    : undefined;
  for (const safetyBreak of manifest.allowedSafetyBreaks) {
    const dossier = linkedDossiers?.get(safetyBreak.calculatorId);
    const compatibilityClaim = dossier?.claims.find((entry) => entry.id === safetyBreak.compatibilityClaimId);
    const clinicalClaim = dossier?.claims.find((entry) => entry.id === safetyBreak.clinicalClaimId);
    const expectedCoverage = `compatibility:${safetyBreak.surface}`;
    const compatibilityLinkValid = compatibilityClaim !== undefined &&
      compatibilityClaim.scope === 'compatibility' &&
      ['supported', 'variant_specific'].includes(compatibilityClaim.status) &&
      compatibilityClaim.statement === safetyBreak.rationale &&
      compatibilityClaim.compatibilityDecision?.oldBehavior === safetyBreak.oldBehavior &&
      compatibilityClaim.compatibilityDecision.replacement === safetyBreak.replacement &&
      compatibilityClaim.compatibilityDecision.rationale === safetyBreak.rationale &&
      compatibilityClaim.covers.length === 1 && compatibilityClaim.covers[0] === expectedCoverage;
    const clinicalLinkValid = clinicalClaim !== undefined && clinicalClaim.scope === 'clinical' &&
      ['supported', 'variant_specific'].includes(clinicalClaim.status) &&
      clinicalClaim.sourceIds.length > 0 && clinicalClaim.locators.length > 0 &&
      clinicalClaim.covers.length === 1 && clinicalClaim.covers[0] === safetyBreak.clinicalClaimCoverage;
    const digestsValid = safetyBreak.oldValueDigest === valueDigest(expected.get(safetyBreak.surface)) &&
      safetyBreak.replacementValueDigest === valueDigest(actual.get(safetyBreak.surface));
    if (!compatibilityLinkValid || !clinicalLinkValid || !digestsValid) {
      const reasons = [
        !compatibilityLinkValid ? `missing supported compatibility claim for ${expectedCoverage}` : undefined,
        !clinicalLinkValid ? 'missing independently sourced clinical claim' : undefined,
        !digestsValid ? 'old/replacement surface digests do not match the frozen and live values' : undefined,
      ].filter((reason): reason is string => reason !== undefined);
      differences.push(`invalid safety break ${safetyBreak.id}: ${reasons.join('; ')}`);
    } else {
      validBreaks.add(safetyBreak.surface);
    }
  }
  // Schema 1.1 is explicitly additive: new envelope fields and new typed error
  // discriminants do not remove or change any 1.0 client contract.
  const additivePrefixes = ['resultEnvelopeFields:', 'errorDiscriminants:'];
  const changedSurfaces = new Set<string>();
  for (const surface of new Set([...actual.keys(), ...expected.keys()])) {
    if (canonicalJson(actual.get(surface)) !== canonicalJson(expected.get(surface))) {
      changedSurfaces.add(surface);
      if (expected.get(surface) === undefined &&
        additivePrefixes.some((prefix) => surface.startsWith(prefix))) {
        continue;
      }
      if (!validBreaks.has(surface)) differences.push(`changed compatibility surface: ${surface}`);
    }
  }
  for (const surface of validBreaks) {
    if (!changedSurfaces.has(surface)) differences.push(`unused safety break surface: ${surface}`);
  }
  return { ok: differences.length === 0, differences };
}
