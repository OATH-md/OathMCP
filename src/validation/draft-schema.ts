import * as z from 'zod/v4';
import { SpecSchema, type CalcSpec } from '../engine/spec-schema.js';
import { ValidationDossierSchema, type ValidationDossier } from './schema.js';

export const CALCULATOR_ARCHETYPES = ['formula', 'score', 'lookup', 'interpreter'] as const;
export const CalculatorArchetypeSchema = z.enum(CALCULATOR_ARCHETYPES);
export const CalculatorIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'use lowercase snake_case');
export const DraftMetadataSchema = z.strictObject({
  draftVersion: z.literal('1.0'),
  archetype: CalculatorArchetypeSchema,
  todos: z.array(z.string().min(1)),
});

export const DraftCalculatorSchema = z.strictObject({
  id: CalculatorIdSchema,
  archetype: CalculatorArchetypeSchema,
  spec: z.record(z.string(), z.unknown()),
  validation: z.record(z.string(), z.unknown()),
  computeSource: z.string().min(1),
});

export type CalculatorArchetype = z.infer<typeof CalculatorArchetypeSchema>;
export type DraftCalculator = z.infer<typeof DraftCalculatorSchema>;

export interface ProductionCandidate {
  id: string;
  spec: CalcSpec;
  dossier: ValidationDossier;
  computeSource: string;
}

function withoutDraft(record: Record<string, unknown>): Record<string, unknown> {
  const { draft: _draft, ...production } = record;
  return production;
}

function findPlaceholders(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    return /\bTODO\b|__CALCULATOR_ID__/.test(value) ? [path] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => findPlaceholders(entry, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => findPlaceholders(entry, `${path}.${key}`));
  }
  return [];
}

export function validateDraftForProduction(draft: DraftCalculator): {
  issues: string[];
  candidate?: ProductionCandidate;
} {
  const issues = [
    ...findPlaceholders(draft.spec, 'spec'),
    ...findPlaceholders(draft.validation, 'validation'),
    ...findPlaceholders(draft.computeSource, 'compute'),
  ].map((path) => `${path}: unresolved TODO or placeholder`);
  const specTodos = DraftMetadataSchema.parse(draft.spec.draft).todos;
  const validationTodos = DraftMetadataSchema.parse(draft.validation.draft).todos;
  if (specTodos.length > 0) issues.push(`spec.draft.todos: ${specTodos.length} unresolved item(s)`);
  if (validationTodos.length > 0) issues.push(`validation.draft.todos: ${validationTodos.length} unresolved item(s)`);
  if (!/export\s+(?:default\s+)?function\s+compute\s*\(/.test(draft.computeSource)) {
    issues.push('compute.ts must export a standalone function named compute');
  }
  if (issues.length > 0) return { issues };

  try {
    const spec = SpecSchema.parse(withoutDraft(draft.spec));
    const dossier = ValidationDossierSchema.parse(withoutDraft(draft.validation));
    if (spec.id !== draft.id || dossier.calculatorId !== draft.id) {
      issues.push('draft directory, spec id, and dossier calculatorId must match');
    }
    if (dossier.specVersion !== spec.version) issues.push('dossier specVersion must match spec version');
    const referenceCases = dossier.cases.filter((entry) => entry.kind === 'reference');
    if (referenceCases.length < 3) issues.push('at least three source-linked reference cases are required');
    if (issues.length === 0) {
      return { issues, candidate: { id: draft.id, spec, dossier, computeSource: draft.computeSource } };
    }
  } catch (error) {
    issues.push(error instanceof z.ZodError ? z.prettifyError(error) : String(error));
  }
  return { issues };
}
