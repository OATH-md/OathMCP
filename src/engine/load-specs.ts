/**
 * Spec loader: reads every `specs/*.yaml`, parses with `yaml`, and validates
 * each against `SpecSchema`. On any failure it throws one aggregated error
 * listing the offending file(s) and the Zod issue(s), so an authoring mistake
 * surfaces loudly at startup rather than as a runtime surprise.
 *
 * Specs are cached after the first successful load.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SpecSchema, type CalcSpec } from './spec-schema.js';
import { ANALYTES } from './units.js';
import {
  findUncoveredNumericBandValue,
  matchesWhen,
  numericWhenBoundaries,
} from './bands.js';
import { templatePlaceholders } from './prompt-template.js';
import {
  assertNamingConventions,
  assertSharedInputCompatibility,
} from './lint-specs.js';
import { InputError } from './errors.js';

/**
 * Validate that every `quantity` input agrees with the conversion table: the
 * analyte must exist, its canonicalUnit must match, and every
 * acceptedUnit must be known. This is a spec-authoring invariant, so it is
 * checked once at load time rather than on every `run()`; failures join the
 * aggregated startup error list.
 */
function analyteIssues(spec: CalcSpec): string[] {
  const issues: string[] = [];
  for (const [name, input] of Object.entries(spec.inputs)) {
    if (input.kind !== 'quantity' || input.quantity === undefined) continue;
    const { analyte: id, canonicalUnit, acceptedUnits } = input.quantity;
    const analyte = ANALYTES[id];
    if (analyte === undefined) {
      issues.push(`inputs.${name}: unknown analyte '${id}'`);
      continue;
    }
    if (analyte.canonicalUnit !== canonicalUnit) {
      issues.push(
        `inputs.${name}: canonicalUnit '${canonicalUnit}' disagrees with the conversion table ('${analyte.canonicalUnit}') for analyte '${id}'`,
      );
    }
    for (const unit of acceptedUnits) {
      if (!(unit in analyte.units)) {
        issues.push(`inputs.${name}: accepted unit '${unit}' is unknown for analyte '${id}'`);
      }
    }
  }
  return issues;
}

/**
 * Validate that every warning rule references a declared input. A typo'd
 * `field` would otherwise silently disable the warning at run time (the runner's
 * `computeInputs[field]` would be undefined), so this is checked once at load
 * time alongside the analyte-drift check to keep the fail-loud invariant.
 */
function warningIssues(spec: CalcSpec): string[] {
  const issues: string[] = [];
  for (const rule of spec.warnings ?? []) {
    if (!Object.hasOwn(spec.inputs, rule.field)) {
      issues.push(`warnings: field '${rule.field}' is not a declared input`);
    }
    try {
      matchesWhen(rule.when, 0);
    } catch (error) {
      issues.push(`warnings: ${(error as Error).message}`);
    }
    for (const condition of rule.where ?? []) {
      if (!Object.hasOwn(spec.inputs, condition.field)) {
        issues.push(`warnings: field '${condition.field}' is not a declared input`);
      }
      try {
        matchesWhen(condition.when, 0);
      } catch (error) {
        issues.push(`warnings: ${(error as Error).message}`);
      }
    }
  }
  return issues;
}

/** Ensure compatibility aliases are unambiguous within one calculator. */
function aliasIssues(spec: CalcSpec): string[] {
  const issues: string[] = [];
  const claimed = new Map<string, string>();
  for (const [name, input] of Object.entries(spec.inputs)) {
    for (const token of [name, ...(input.aliases ?? [])]) {
      const owner = claimed.get(token);
      if (owner !== undefined && owner !== name) {
        issues.push(`inputs.${name}: name or alias '${token}' is already owned by '${owner}'`);
      } else {
        claimed.set(token, name);
      }
    }

    if (input.kind !== 'enum') continue;
    const optionTokens = new Map<string, string>();
    for (const option of input.enumValues ?? []) {
      for (const token of [option.value, ...(option.aliases ?? [])]) {
        const owner = optionTokens.get(token);
        if (owner !== undefined && owner !== option.value) {
          issues.push(
            `inputs.${name}.enumValues: value or alias '${token}' is already owned by '${owner}'`,
          );
        } else {
          optionTokens.set(token, option.value);
        }
      }
    }
  }
  return issues;
}

/** Ensure every cross-field constraint references a compatible declared input. */
function constraintIssues(spec: CalcSpec): string[] {
  const issues: string[] = [];
  const declared = new Set(Object.keys(spec.inputs));
  const requireField = (field: string, path: string): void => {
    if (!declared.has(field)) issues.push(`${path}: unknown input '${field}'`);
  };

  for (const [index, constraint] of (spec.constraints ?? []).entries()) {
    const path = `constraints.${index}`;
    if (constraint.kind === 'atLeastOne') {
      constraint.fields.forEach((field) => requireField(field, `${path}.fields`));
      continue;
    }
    if (constraint.kind === 'requiredWhen') {
      requireField(constraint.field, `${path}.field`);
      constraint.required.forEach((field) => requireField(field, `${path}.required`));
      try {
        matchesWhen(constraint.when, 0);
      } catch (error) {
        issues.push(`${path}.when: ${(error as Error).message}`);
      }
      continue;
    }
    if (constraint.kind === 'requireValueWhen' || constraint.kind === 'forbidValueWhen') {
      requireField(constraint.field, `${path}.field`);
      requireField(constraint.target, `${path}.target`);
      constraint.where?.forEach((condition) => requireField(condition.field, `${path}.where`));
      try {
        matchesWhen(constraint.when, 0);
        constraint.where?.forEach((condition) => matchesWhen(condition.when, 0));
      } catch (error) {
        issues.push(`${path}.when: ${(error as Error).message}`);
      }
      const target = spec.inputs[constraint.target];
      if (target?.kind === 'enum' && !target.enumValues.some((option) => option.value === constraint.value)) {
        issues.push(`${path}.value: '${String(constraint.value)}' is not valid for '${constraint.target}'`);
      }
      continue;
    }
    if (constraint.kind === 'requireAtLeastValuesWhen') {
      requireField(constraint.field, `${path}.field`);
      if ((constraint.minimum ?? 1) > constraint.targets.length) {
        issues.push(`${path}.minimum: cannot exceed the number of targets`);
      }
      for (const [targetIndex, target] of constraint.targets.entries()) {
        requireField(target.field, `${path}.targets.${targetIndex}.field`);
        const input = spec.inputs[target.field];
        if (input?.kind === 'enum' && !input.enumValues.some((option) => option.value === target.value)) {
          issues.push(`${path}.targets.${targetIndex}.value: '${String(target.value)}' is not valid for '${target.field}'`);
        }
      }
      try {
        matchesWhen(constraint.when, 0);
      } catch (error) {
        issues.push(`${path}.when: ${(error as Error).message}`);
      }
      continue;
    }

    if (constraint.kind === 'forbidPresentWhen') {
      requireField(constraint.field, `${path}.field`);
      constraint.forbidden.forEach((field) => requireField(field, `${path}.forbidden`));
      try {
        matchesWhen(constraint.when, 0);
      } catch (error) {
        issues.push(`${path}.when: ${(error as Error).message}`);
      }
      continue;
    }

    requireField(constraint.left, `${path}.left`);
    requireField(constraint.right, `${path}.right`);
    if (!['==', '!='].includes(constraint.operator)) {
      for (const field of [constraint.left, constraint.right]) {
        const kind = spec.inputs[field]?.kind;
        if (kind !== undefined && !['number', 'integer', 'quantity'].includes(kind)) {
          issues.push(`${path}: '${field}' must be numeric for '${constraint.operator}'`);
        }
      }
    }
  }
  return issues;
}

/** Ensure prompt templates can be filled entirely from inputs and outputs. */
function promptIssues(spec: CalcSpec): string[] {
  if (spec.prompt === undefined) return [];
  const declared = new Set([
    ...Object.keys(spec.inputs),
    ...Object.keys(spec.outputs),
  ]);
  const issues: string[] = [];
  let placeholders: string[];
  try {
    placeholders = templatePlaceholders(spec.prompt.template);
  } catch (error) {
    return [`prompt.template: ${(error as Error).message}`];
  }
  for (const name of placeholders) {
    if (!declared.has(name)) {
      issues.push(`prompt.template: unknown placeholder '${name}'`);
    }
  }
  return [...new Set(issues)];
}

/** Parse interpretation expressions and prove numeric bands cover all values. */
function oneBandSetIssues(
  spec: CalcSpec,
  path: string,
  bands: NonNullable<CalcSpec['interpretationBands']>,
): string[] {
  const issues: string[] = [];
  for (const [index, band] of bands.entries()) {
    for (const condition of band.where ?? []) {
      if (!Object.hasOwn(spec.inputs, condition.field)) {
        issues.push(`${path}.${index}.where: unknown input '${condition.field}'`);
      }
      try {
        matchesWhen(condition.when, 0);
      } catch (error) {
        issues.push(`${path}.${index}.where: ${(error as Error).message}`);
      }
    }
  }
  try {
    const segmentFields = [
      ...new Set(bands.flatMap((band) => (band.where ?? []).map((item) => item.field))),
    ];
    let contexts: Array<Record<string, number | string | boolean>> = [{}];
    for (const field of segmentFields) {
      const input = spec.inputs[field];
      let values: Array<number | string | boolean> = [];
      if (input?.kind === 'enum') {
        values = (input.enumValues ?? []).map((option) => option.value);
      } else if (input?.kind === 'boolean') {
        values = [false, true];
      } else if (
        input !== undefined &&
        ['number', 'integer', 'quantity'].includes(input.kind)
      ) {
        const conditions = bands.flatMap((band) =>
          (band.where ?? [])
            .filter((item) => item.field === field)
            .map((item) => item.when),
        );
        const boundaries = conditions.flatMap((when) => {
          const parsed = numericWhenBoundaries(when);
          if (parsed === null) {
            throw new Error(
              `${path}: numeric segment field '${field}' requires numeric conditions`,
            );
          }
          return parsed;
        });
        const [lo, hi] = input.hardLimits ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
        const ordered = [...new Set([lo, ...boundaries, hi])].sort((a, b) => a - b);
        const probes = new Set<number>(ordered);
        for (let index = 1; index < ordered.length; index += 1) {
          const left = ordered[index - 1];
          const right = ordered[index];
          if (Number.isFinite(left) && Number.isFinite(right)) {
            probes.add((left + right) / 2);
          } else if (!Number.isFinite(left) && Number.isFinite(right)) {
            probes.add(right - 1);
          } else if (Number.isFinite(left) && !Number.isFinite(right)) {
            probes.add(left + 1);
          }
        }
        values = [...probes];
      }

      contexts = contexts.flatMap((context) =>
        values.map((value) => ({ ...context, [field]: value })),
      );
    }

    for (const context of contexts) {
      const uncovered = findUncoveredNumericBandValue(
        bands,
        segmentFields.length > 0 ? context : undefined,
      );
      if (uncovered !== null) {
        const segment = segmentFields
          .map((field) => `${field}=${String(context[field])}`)
          .join(', ');
        issues.push(
          `${path}: no band matches value ${uncovered}${segment ? ` for segment ${segment}` : ''}`,
        );
      }
    }
  } catch (error) {
    issues.push(`${path}: ${(error as Error).message}`);
  }
  return issues;
}

function bandIssues(spec: CalcSpec): string[] {
  const issues: string[] = [];
  if (spec.interpretationBands !== undefined) {
    issues.push(...oneBandSetIssues(spec, 'interpretationBands', spec.interpretationBands));
  }
  for (const [name, output] of Object.entries(spec.outputs)) {
    if (output.interpretationBands !== undefined) {
      issues.push(
        ...oneBandSetIssues(
          spec,
          `outputs.${name}.interpretationBands`,
          output.interpretationBands,
        ),
      );
    }
  }
  return issues;
}

function semanticContractIssues(spec: CalcSpec): string[] {
  const issues: string[] = [];
  const sourceIds = new Set(spec.evidence.map((source) => source.id));
  const usedSources = new Set<string>();
  const checkRefs = (refs: readonly string[], path: string): void => {
    for (const ref of refs) {
      if (!sourceIds.has(ref)) issues.push(`${path}: unknown evidence reference '${ref}'`);
      usedSources.add(ref);
    }
  };
  checkRefs(spec.clinicalModel.evidenceRefs, 'clinicalModel.evidenceRefs');
  checkRefs(spec.applicability.evidenceRefs, 'applicability.evidenceRefs');
  for (const [name, input] of Object.entries(spec.inputs)) {
    checkRefs(input.sourceRefs, `inputs.${name}.sourceRefs`);
    if ('observation' in input && input.observation !== undefined) {
      const timestamp = spec.inputs[input.observation.timestampField];
      if (timestamp === undefined || !['number', 'integer'].includes(timestamp.kind)) {
        issues.push(`inputs.${name}.observation.timestampField must reference a numeric timestamp input`);
      }
      if (input.observation.timestampField === name) {
        issues.push(`inputs.${name}.observation.timestampField must not reference itself`);
      }
      if (input.observation.baselineField !== undefined) {
        const baseline = spec.inputs[input.observation.baselineField];
        if (baseline === undefined || !['number', 'integer', 'quantity'].includes(baseline.kind)) {
          issues.push(`inputs.${name}.observation.baselineField must reference a numeric baseline input`);
        } else if (baseline.kind !== input.kind) {
          issues.push(`inputs.${name}.observation baseline and observation kinds must match`);
        } else if (input.kind === 'quantity' && baseline.kind === 'quantity' &&
          (baseline.quantity.analyte !== input.quantity.analyte ||
            baseline.quantity.canonicalUnit !== input.quantity.canonicalUnit)) {
          issues.push(`inputs.${name}.observation baseline quantity must use the same analyte and canonical unit`);
        }
      }
    }
  }
  const checkBands = (bands: CalcSpec['interpretationBands'], path: string): void => {
    for (const [index, band] of (bands ?? []).entries()) {
      checkRefs(band.evidenceRefs, `${path}.${index}.evidenceRefs`);
    }
  };
  checkBands(spec.interpretationBands, 'interpretationBands');
  for (const [name, output] of Object.entries(spec.outputs)) {
    checkRefs(output.evidenceRefs, `outputs.${name}.evidenceRefs`);
    checkBands(output.interpretationBands, `outputs.${name}.interpretationBands`);
    if (output.availability.kind === 'whenAnyInputPresent' || output.availability.kind === 'whenAllInputsPresent') {
      for (const field of output.availability.fields) {
        if (!Object.hasOwn(spec.inputs, field)) issues.push(`outputs.${name}.availability: unknown input '${field}'`);
      }
    }
  }
  for (const [index, warning] of (spec.warnings ?? []).entries()) {
    checkRefs(warning.evidenceRefs, `warnings.${index}.evidenceRefs`);
    if (warning.adjustmentId !== undefined && !(spec.adjustments ?? []).some((adjustment) => adjustment.id === warning.adjustmentId)) {
      issues.push(`warnings.${index}.adjustmentId: unknown adjustment '${warning.adjustmentId}'`);
    }
  }
  for (const [index, adjustment] of (spec.adjustments ?? []).entries()) {
    checkRefs(adjustment.evidenceRefs, `adjustments.${index}.evidenceRefs`);
    const target = adjustment.target.kind === 'input'
      ? spec.inputs[adjustment.target.field]
      : spec.outputs[adjustment.target.field];
    if (target === undefined || !['number', 'integer', 'quantity'].includes(target.kind)) {
      issues.push(`adjustments.${index}.target must reference a numeric ${adjustment.target.kind}`);
    }
    if (adjustment.condition !== undefined) {
      const conditionInput = spec.inputs[adjustment.condition.field];
      if (conditionInput === undefined) issues.push(`adjustments.${index}.condition references unknown input '${adjustment.condition.field}'`);
      else if (
        (conditionInput.kind === 'boolean' && typeof adjustment.condition.value !== 'boolean') ||
        (conditionInput.kind === 'enum' && (typeof adjustment.condition.value !== 'string' || !conditionInput.enumValues.some((option) => option.value === adjustment.condition?.value))) ||
        (['number', 'integer', 'quantity'].includes(conditionInput.kind) && typeof adjustment.condition.value !== 'number')
      ) issues.push(`adjustments.${index}.condition value disagrees with input '${adjustment.condition.field}'`);
    }
    if (adjustment.verifyOutput !== undefined) {
      const output = spec.outputs[adjustment.verifyOutput];
      if (adjustment.target.kind !== 'input') issues.push(`adjustments.${index}.verifyOutput is valid only for input adjustments`);
      if (output === undefined || !['number', 'integer'].includes(output.kind)) issues.push(`adjustments.${index}.verifyOutput must reference a numeric output`);
    }
    if (adjustment.verifyTolerance !== undefined && adjustment.verifyOutput === undefined) {
      issues.push(`adjustments.${index}.verifyTolerance requires verifyOutput`);
    }
    if (adjustment.appliedOutput !== undefined) {
      const output = spec.outputs[adjustment.appliedOutput];
      if (adjustment.target.kind !== 'input') issues.push(`adjustments.${index}.appliedOutput is valid only for input adjustments`);
      if (output?.kind !== 'boolean') issues.push(`adjustments.${index}.appliedOutput must reference a boolean output`);
    }
    if (adjustment.operation === 'clamp' && adjustment.minimum > adjustment.maximum) issues.push(`adjustments.${index}: clamp minimum exceeds maximum`);
  }
  if (spec.scoring) {
    checkRefs(spec.scoring.evidenceRefs, 'scoring.evidenceRefs');
    if (!Object.hasOwn(spec.outputs, spec.scoring.output)) issues.push(`scoring.output: unknown output '${spec.scoring.output}'`);
    let minimum = 0;
    let maximum = 0;
    for (const [index, component] of spec.scoring.components.entries()) {
      const input = spec.inputs[component.field];
      if (input !== undefined && !input.required && input.default === undefined) {
        issues.push(`scoring.components.${index}: scoring input must be required or defaulted`);
      }
      if (component.kind === 'enum') {
        if (input?.kind !== 'enum' || input.enumValues.some((option) => option.scorable !== false && option.points === undefined)) {
          issues.push(`scoring.components.${index}: enum component requires points or an explicit not-testable option`);
          continue;
        }
        const points = input.enumValues.flatMap((option) => option.scorable === false ? [] : [option.points as number]);
        if (points.length === 0) {
          issues.push(`scoring.components.${index}: enum component must have at least one scorable option`);
          continue;
        }
        minimum += Math.min(...points);
        maximum += Math.max(...points);
      } else if (component.kind === 'boolean') {
        if (input?.kind !== 'boolean') issues.push(`scoring.components.${index}: boolean component requires boolean input`);
        minimum += Math.min(component.truePoints, component.falsePoints);
        maximum += Math.max(component.truePoints, component.falsePoints);
      } else {
        if (input === undefined || !['number', 'integer', 'quantity'].includes(input.kind)) {
          issues.push(`scoring.components.${index}: threshold component requires numeric input`);
        }
        minimum += Math.min(component.truePoints, component.falsePoints);
        maximum += Math.max(component.truePoints, component.falsePoints);
      }
    }
    if (minimum !== spec.scoring.range[0] || maximum !== spec.scoring.range[1]) issues.push(`scoring.range must equal derived component range [${minimum}, ${maximum}]`);
  }
  for (const source of sourceIds) {
    if (!usedSources.has(source)) issues.push(`evidence: source '${source}' is not referenced by any clinical contract`);
  }
  return issues;
}

let cache: Map<string, CalcSpec> | null = null;

/** Validate the calculator-family lifecycle as a reciprocal acyclic graph. */
function lifecycleIssues(specs: ReadonlyMap<string, CalcSpec>): string[] {
  const issues: string[] = [];
  const variants = new Map<string, string>();
  const graph = new Map<string, string[]>();

  for (const spec of specs.values()) {
    if ((spec.family === undefined) !== (spec.variant === undefined)) {
      issues.push(`${spec.id}: family and variant must be declared together`);
    }
    if (spec.family !== undefined && spec.variant !== undefined) {
      const identity = `${spec.family}:${spec.variant}`;
      const owner = variants.get(identity);
      if (owner !== undefined) issues.push(`${spec.id}: family/variant '${identity}' is already owned by '${owner}'`);
      else variants.set(identity, spec.id);
    }

    const supersedes = spec.supersedes ?? [];
    const supersededBy = spec.supersededBy ?? [];
    graph.set(spec.id, supersedes);
    for (const targetId of [...supersedes, ...supersededBy]) {
      const target = specs.get(targetId);
      if (target === undefined) {
        issues.push(`${spec.id}: lifecycle reference '${targetId}' does not name a catalog calculator`);
        continue;
      }
      if (targetId === spec.id) issues.push(`${spec.id}: lifecycle references must not point to self`);
      if (spec.family === undefined || target.family === undefined || spec.family !== target.family) {
        issues.push(`${spec.id}: lifecycle reference '${targetId}' must stay within one declared family`);
      }
    }
    for (const targetId of supersedes) {
      const target = specs.get(targetId);
      if (target !== undefined && !(target.supersededBy ?? []).includes(spec.id)) {
        issues.push(`${spec.id}: supersedes '${targetId}' requires reciprocal supersededBy metadata`);
      }
    }
    for (const targetId of supersededBy) {
      const target = specs.get(targetId);
      if (target !== undefined && !(target.supersedes ?? []).includes(spec.id)) {
        issues.push(`${spec.id}: supersededBy '${targetId}' requires reciprocal supersedes metadata`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      issues.push(`lifecycle graph contains a cycle: ${[...path.slice(cycleStart), id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of graph.get(id) ?? []) {
      if (specs.has(target)) visit(target, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id, []);
  return [...new Set(issues)];
}

function validateSources(sources: [file: string, text: string][]): Map<string, CalcSpec> {
  const specs = new Map<string, CalcSpec>();
  const errors: string[] = [];

  for (const [file, text] of sources) {
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (e) {
      errors.push(`${file}: YAML parse error — ${(e as Error).message}`);
      continue;
    }

    const result = SpecSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${file}: ${issue.path.join('.')} — ${issue.message}`);
      }
      continue;
    }

    const spec = result.data;
    const fileId = basename(file, extname(file));
    if (fileId !== spec.id) {
      errors.push(`${file}: filename must match spec id '${spec.id}'`);
      continue;
    }
    if (specs.has(spec.id)) {
      errors.push(`${file}: duplicate spec id '${spec.id}'`);
      continue;
    }

    const driftIssues = [
      ...analyteIssues(spec),
      ...warningIssues(spec),
      ...aliasIssues(spec),
      ...constraintIssues(spec),
      ...promptIssues(spec),
      ...bandIssues(spec),
      ...semanticContractIssues(spec),
    ];
    if (driftIssues.length > 0) {
      for (const issue of driftIssues) errors.push(`${file}: ${issue}`);
      continue;
    }

    specs.set(spec.id, spec);
  }

  if (errors.length > 0) {
    throw new Error(`Spec validation failed:\n  - ${errors.join('\n  - ')}`);
  }
  assertSharedInputCompatibility(specs.values());
  errors.push(...lifecycleIssues(specs));
  if (errors.length > 0) throw new Error(`Spec validation failed:\n  - ${errors.join('\n  - ')}`);
  assertNamingConventions(specs.values());
  return specs;
}

function readAndValidate(): Map<string, CalcSpec> {
  // Resolve the filesystem path lazily. Cloudflare Workers prime the catalog
  // from bundled text and never call this Node-only branch; evaluating
  // fileURLToPath(import.meta.url) at module load breaks workerd validation.
  const specsDir = join(dirname(fileURLToPath(import.meta.url)), '../../specs');
  const files = readdirSync(specsDir).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
  );
  return validateSources(files.map((f) => [f, readFileSync(join(specsDir, f), 'utf8')]));
}

/** Validate an in-memory set of YAML specs using the production catalog rules. */
export function validateSpecTexts(texts: Record<string, string>): Map<string, CalcSpec> {
  return validateSources(Object.entries(texts));
}

/**
 * Prime the spec cache from in-memory YAML texts (keyed by filename), applying
 * the same validation as the disk path. For runtimes with no filesystem
 * (Cloudflare Workers), where the specs are bundled at build time — call once
 * at startup, before the first `loadSpecs()`.
 */
export function primeSpecs(texts: Record<string, string>): void {
  cache = validateSpecTexts(texts);
}

/** Load and validate all specs (cached after first call). */
export function loadSpecs(): Map<string, CalcSpec> {
  if (cache === null) {
    cache = readAndValidate();
  }
  return cache;
}

/** Load a single spec by id. Throws if it does not exist. */
export function loadSpec(id: string): CalcSpec {
  const spec = loadSpecs().get(id);
  if (spec === undefined) {
    throw new InputError({
      code: 'UNKNOWN_CALCULATOR',
      field: 'id',
      message: `Unknown calculator '${id}'.`,
      expected: [...loadSpecs().keys()].join(' | '),
      allowed: [...loadSpecs().keys()],
    });
  }
  return spec;
}
