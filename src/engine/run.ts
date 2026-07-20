/** Execute one calculator through the strict spec/runtime contract. */
import { loadSpec } from './load-specs.js';
import { getCompute, type ComputeFn, type ComputeInputs, type ComputedValue } from './registry.js';
import { evaluateBands, matchesWhen } from './bands.js';
import { enforceConstraints } from './constraints.js';
import { convert, resolveUnit } from './units.js';
import { CalculationError, HardLimitError, InputError } from './errors.js';
import { availabilityShouldBePresent } from './output-availability.js';
import type { InputSpec, OutputSpec } from './spec-schema.js';
import type { CalculatorId, ComputeValue } from '../compute/types.generated.js';
import { clinicalDataAssetFor } from '../clinical-data/index.js';
import '../compute/index.generated.js';

export interface ResultValue {
  name: string;
  title: string;
  value: ComputeValue;
  unit?: string;
}

export interface UsedInput {
  value: number | string | boolean;
  unit?: string;
}

export interface InputProvenance {
  source: 'supplied' | 'default' | 'alias';
  suppliedAs: string;
  original?: { value: number; unit?: string };
  normalized: UsedInput;
}

export interface CalcResult {
  schemaVersion: '1.1';
  id: string;
  version: string;
  clinicalModel: {
    modelKind: 'formula' | 'score' | 'decision_tree' | 'policy' | 'lookup';
    modelId: string;
    modelVersion: string;
    jurisdiction?: string;
    dataSnapshot?: string;
    effectiveDate?: string;
    reviewDate?: string;
    reviewAfter?: string;
    stale: boolean;
  };
  results: ResultValue[];
  interpretation?: { label: string; severity: string };
  interpretations: Array<{
    output: string;
    code: string;
    kind: string;
    label: string;
    severity: string;
    evidenceRefs: string[];
  }>;
  warnings: string[];
  inputsUsed: Record<string, UsedInput>;
  inputProvenance: Record<string, InputProvenance>;
  adjustments: Array<{
    id: string;
    target: { kind: 'input' | 'output'; field: string };
    operation: 'cap' | 'floor' | 'clamp';
    original: number;
    effective: number;
    applied: boolean;
    conditionMatched: boolean;
    bounds: { minimum?: number; maximum?: number };
    verifyOutput?: string;
    verifyTolerance?: number;
    appliedOutput?: string;
    evidenceRefs: string[];
  }>;
  scoringComponents: Array<{
    field: string;
    label: string;
    value: string | number | boolean;
    points?: number;
    testable: boolean;
    reason?: string;
  }>;
  scoreComplete: boolean;
  scoreMissingReasons: string[];
  evidence: Array<{
    id: string;
    type: string;
    citation: string;
    locator: string;
    doi?: string;
    url?: string;
  }>;
}

export type RawInputs = Record<string, unknown>;
const allowedInputCache = new WeakMap<CalcSpecForInputCache, {
  names: ReadonlySet<string>;
  sorted: string[];
}>();
type CalcSpecForInputCache = ReturnType<typeof loadSpec>;

export function clinicalModelProvenance(
  spec: CalcSpecForInputCache,
  todayIso = new Date().toISOString().slice(0, 10),
): CalcResult['clinicalModel'] {
  const asset = clinicalDataAssetFor(spec.id);
  return {
    modelKind: spec.clinicalModel.modelKind,
    modelId: spec.clinicalModel.modelId,
    modelVersion: spec.clinicalModel.modelVersion,
    ...(spec.clinicalModel.jurisdiction ? { jurisdiction: spec.clinicalModel.jurisdiction } : {}),
    ...(spec.clinicalModel.dataSnapshot ? { dataSnapshot: spec.clinicalModel.dataSnapshot } : {}),
    ...(spec.clinicalModel.effectiveDate ? { effectiveDate: spec.clinicalModel.effectiveDate } : {}),
    ...(spec.clinicalModel.reviewDate ? { reviewDate: spec.clinicalModel.reviewDate } : {}),
    ...(spec.reviewAfter ? { reviewAfter: spec.reviewAfter } : {}),
    stale: (spec.reviewAfter !== undefined && todayIso > spec.reviewAfter) ||
      (asset !== undefined && todayIso > asset.reviewAfter),
  };
}

function allowedInputs(spec: CalcSpecForInputCache): { names: ReadonlySet<string>; sorted: string[] } {
  const cached = allowedInputCache.get(spec);
  if (cached !== undefined) return cached;
  const names = new Set(Object.entries(spec.inputs).flatMap(([name, input]) => [name, ...(input.aliases ?? [])]));
  const value = { names, sorted: [...names].sort() };
  allowedInputCache.set(spec, value);
  return value;
}

function isQuantityObject(value: unknown): value is { value: number; unit: string } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { value?: unknown }).value === 'number' &&
    typeof (value as { unit?: unknown }).unit === 'string';
}

function resolveInput(name: string, spec: InputSpec, raw: unknown): UsedInput {
  if (spec.kind === 'boolean') {
    if (typeof raw !== 'boolean') throw new InputError({ field: name, message: `${spec.title} must be a boolean.`, expected: 'true or false' });
    return { value: raw };
  }
  if (spec.kind === 'enum') {
    const allowed = spec.enumValues.map((option) => option.value);
    const option = typeof raw === 'string'
      ? spec.enumValues.find((candidate) => candidate.value === raw || candidate.aliases?.includes(raw))
      : undefined;
    if (option === undefined) {
      throw new InputError({ code: 'BAD_ENUM', field: name, message: `${spec.title} must be one of: ${allowed.join(', ')}.`, expected: allowed.join(' | '), allowed });
    }
    return { value: option.value };
  }
  if (spec.kind === 'number' || spec.kind === 'integer') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new InputError({ code: 'BAD_TYPE', field: name, message: `${spec.title} must be a finite number.`, expected: spec.kind });
    if (spec.kind === 'integer' && !Number.isInteger(raw)) throw new InputError({ field: name, message: `${spec.title} must be a whole number.`, expected: 'integer' });
    return { value: raw };
  }
  const quantity = spec.quantity;
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw, unit: quantity.canonicalUnit };
  if (isQuantityObject(raw) && Number.isFinite(raw.value)) {
    const resolvedUnit = resolveUnit(quantity.analyte, raw.unit);
    if (resolvedUnit === undefined || !quantity.acceptedUnits.includes(resolvedUnit)) {
      throw new InputError({ code: 'UNKNOWN_UNIT', field: name, message: `Unit '${raw.unit}' is not accepted for ${spec.title}.`, expected: quantity.acceptedUnits.join(' | '), allowed: quantity.acceptedUnits });
    }
    return { value: convert(quantity.analyte, raw.value, resolvedUnit, quantity.canonicalUnit), unit: quantity.canonicalUnit };
  }
  throw new InputError({ field: name, message: `${spec.title} must be a finite number in ${quantity.canonicalUnit} or { value, unit }.`, expected: `number | { value, unit: ${quantity.acceptedUnits.join(' | ')} }` });
}

function checkRanges(name: string, spec: InputSpec, value: number, unit: string | undefined, warnings: string[]): void {
  const unitLabel = unit ? ` ${unit}` : '';
  if (spec.hardLimits && (value < spec.hardLimits[0] || value > spec.hardLimits[1])) {
    const [min, max] = spec.hardLimits;
    throw new HardLimitError({ field: name, message: `${spec.title} ${value}${unitLabel} is outside physiological limits [${min}, ${max}]${unitLabel}.`, expected: `${min}–${max}${unitLabel}`, min, max });
  }
  if (spec.plausible && (value < spec.plausible[0] || value > spec.plausible[1])) {
    const unitHint = spec.kind === 'quantity'
      ? '; if the source uses another unit, pass it explicitly as { value, unit }'
      : '';
    warnings.push(`${spec.title} ${value}${unitLabel} is unusual (expected ${spec.plausible[0]}–${spec.plausible[1]}${unitLabel})${unitHint}.`);
  }
}

function canonicalizeEnum(name: string, spec: InputSpec, raw: unknown, warnings: string[]): unknown {
  if (spec.kind !== 'enum' || typeof raw !== 'string') return raw;
  const canonical = spec.enumValues.find((option) => option.aliases?.includes(raw))?.value;
  if (canonical !== undefined) {
    warnings.push(`Value '${raw}' for '${name}' is a compatibility alias; use '${canonical}'.`);
    return canonical;
  }
  return raw;
}

function unwrap(value: ComputeValue | ComputedValue | undefined): ComputeValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value
    ? (value as ComputedValue).value
    : value as ComputeValue | undefined;
}

function expectedOutput(output: OutputSpec): string {
  return output.kind === 'enum' ? output.allowedValues.join(' | ') : output.kind;
}

export function validateOutputValue(value: unknown, output: OutputSpec): boolean {
  if (output.kind === 'number') return typeof value === 'number' && Number.isFinite(value) && (!output.range || (value >= output.range[0] && value <= output.range[1]));
  if (output.kind === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) && (!output.range || (value >= output.range[0] && value <= output.range[1]));
  if (output.kind === 'boolean') return typeof value === 'boolean';
  if (output.kind === 'string') return typeof value === 'string';
  if (output.kind === 'enum') return typeof value === 'string' && output.allowedValues.includes(value);
  if (output.kind === 'string_list') return Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (output.kind === 'number_list') return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item) && (!output.itemRange || (item >= output.itemRange[0] && item <= output.itemRange[1])));
  if (output.kind === 'criterion_list') return Array.isArray(value) && value.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return typeof entry.criterion === 'string' && entry.criterion.length > 0 &&
      ['met', 'not_met', 'unknown', 'not_due', 'not_applicable'].includes(String(entry.state)) &&
      (entry.points === undefined || (typeof entry.points === 'number' && Number.isFinite(entry.points))) &&
      Array.isArray(entry.observedInputs) && entry.observedInputs.every((field) => typeof field === 'string') &&
      typeof entry.rationale === 'string' && entry.rationale.length > 0 &&
      Object.keys(entry).every((key) => ['criterion', 'state', 'points', 'observedInputs', 'rationale'].includes(key));
  });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const range = value as { low?: unknown; high?: unknown; mean?: unknown };
  if (typeof range.low !== 'number' || typeof range.high !== 'number' || !Number.isFinite(range.low) || !Number.isFinite(range.high) || range.low > range.high) return false;
  if (range.mean !== undefined && (typeof range.mean !== 'number' || !Number.isFinite(range.mean) || range.mean < range.low || range.mean > range.high)) return false;
  if (output.range && (range.low < output.range[0] || range.high > output.range[1] ||
    (typeof range.mean === 'number' && (range.mean < output.range[0] || range.mean > output.range[1])))) return false;
  return Object.keys(range).every((key) => ['low', 'high', 'mean'].includes(key));
}

function suppliedInterpretation(value: unknown): ComputedValue['interpretation'] | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'interpretation' in value
    ? (value as ComputedValue).interpretation
    : undefined;
}

function adjustedValue(
  value: number,
  adjustment: NonNullable<CalcSpecForInputCache['adjustments']>[number],
): number {
  if (adjustment.operation === 'cap') return Math.min(value, adjustment.maximum);
  if (adjustment.operation === 'floor') return Math.max(value, adjustment.minimum);
  return Math.min(Math.max(value, adjustment.minimum), adjustment.maximum);
}

export function run(id: string, rawInputs: RawInputs): CalcResult {
  const spec = loadSpec(id);
  return runWithContract(spec, getCompute(id), rawInputs);
}

/** @internal Execute the real runner against an injected compute for contract mutation tests. */
export function runWithContract(
  spec: CalcSpecForInputCache,
  compute: ComputeFn,
  rawInputs: RawInputs,
): CalcResult {
  const calculatorId = spec.id as CalculatorId;
  const warnings: string[] = [];
  const clinicalModel = clinicalModelProvenance(spec);
  if (clinicalModel.stale) {
    warnings.push(`Clinical model review expired after ${clinicalModel.reviewAfter}; verify the controlling source and data version before relying on this result.`);
  }
  const inputsUsed: Record<string, UsedInput> = {};
  const inputProvenance: Record<string, InputProvenance> = {};
  const computeInputs: ComputeInputs = {};

  const allowed = allowedInputs(spec);
  const unknown = Object.keys(rawInputs).filter((name) => !allowed.names.has(name));
  if (unknown.length > 0) {
    throw new InputError({ code: 'UNKNOWN_INPUT', field: unknown[0], message: `Unknown input '${unknown[0]}' for ${spec.name}.`, expected: allowed.sorted.join(' | '), allowed: allowed.sorted });
  }

  for (const [name, inputSpec] of Object.entries(spec.inputs)) {
    const canonicalPresent = rawInputs[name] !== undefined;
    const aliases = (inputSpec.aliases ?? []).filter((alias) => rawInputs[alias] !== undefined);
    if ((canonicalPresent && aliases.length > 0) || aliases.length > 1) {
      throw new InputError({ code: 'AMBIGUOUS_ALIAS', field: name, message: `Provide ${name} once; do not combine it with compatibility aliases.`, expected: name, allowed: [name, ...(inputSpec.aliases ?? [])] });
    }
    const alias = aliases[0];
    let source: InputProvenance['source'] = canonicalPresent ? 'supplied' : alias ? 'alias' : 'default';
    let suppliedAs = canonicalPresent ? name : alias ?? name;
    let raw = canonicalPresent ? rawInputs[name] : alias ? rawInputs[alias] : undefined;
    if (raw === undefined) {
      if (inputSpec.default !== undefined) raw = inputSpec.default;
      else if (inputSpec.required) throw new InputError({ code: 'MISSING_REQUIRED', field: name, message: `${inputSpec.title} is required.`, expected: inputSpec.kind });
      else continue;
    }
    if (source === 'alias') warnings.push(`Input '${suppliedAs}' is a compatibility alias; use '${name}'.`);
    raw = canonicalizeEnum(name, inputSpec, raw, warnings);
    const resolved = resolveInput(name, inputSpec, raw);
    if (typeof resolved.value === 'number') checkRanges(name, inputSpec, resolved.value, resolved.unit, warnings);
    inputsUsed[name] = resolved;
    computeInputs[name] = resolved.value;
    const original = typeof raw === 'number'
      ? { value: raw, ...(inputSpec.kind === 'quantity' ? { unit: inputSpec.quantity.canonicalUnit } : {}) }
      : isQuantityObject(raw) ? { value: raw.value, unit: raw.unit } : undefined;
    inputProvenance[name] = { source, suppliedAs, ...(original ? { original } : {}), normalized: resolved };
  }

  enforceConstraints(spec, computeInputs);
  for (const rule of spec.warnings ?? []) {
    const value = computeInputs[rule.field];
    const contextMatches = (rule.where ?? []).every(({ field, when }) => computeInputs[field] !== undefined && matchesWhen(when, computeInputs[field]));
    if (contextMatches && value !== undefined && matchesWhen(rule.when, value)) warnings.push(rule.message);
  }

  const adjustments = spec.adjustments ?? [];
  const effectiveInputs: ComputeInputs = { ...computeInputs };
  const adjustmentEvents: Array<CalcResult['adjustments'][number] | undefined> = [];
  for (const [index, adjustment] of adjustments.entries()) {
    if (adjustment.target.kind !== 'input') continue;
    const conditionMatched = adjustment.condition === undefined ||
      computeInputs[adjustment.condition.field] === adjustment.condition.value;
    const source = effectiveInputs[adjustment.target.field];
    if (typeof source !== 'number' || !Number.isFinite(source)) {
      throw new CalculationError({ code: 'BAD_OUTPUT_TYPE', field: adjustment.target.field, message: `Adjustment '${adjustment.id}' requires a finite numeric input.`, expected: 'number' });
    }
    const effective = conditionMatched ? adjustedValue(source, adjustment) : source;
    effectiveInputs[adjustment.target.field] = effective;
    adjustmentEvents[index] = {
      id: adjustment.id,
      target: adjustment.target,
      operation: adjustment.operation,
      original: source,
      effective,
      applied: source !== effective,
      conditionMatched,
      bounds: {
        ...('minimum' in adjustment ? { minimum: adjustment.minimum } : {}),
        ...('maximum' in adjustment ? { maximum: adjustment.maximum } : {}),
      },
      ...(adjustment.verifyOutput ? { verifyOutput: adjustment.verifyOutput } : {}),
      ...(adjustment.verifyTolerance !== undefined ? { verifyTolerance: adjustment.verifyTolerance } : {}),
      ...(adjustment.appliedOutput ? { appliedOutput: adjustment.appliedOutput } : {}),
      evidenceRefs: adjustment.evidenceRefs,
    };
  }

  const rawOutputs = compute(effectiveInputs);
  for (const [index, adjustment] of adjustments.entries()) {
    if (adjustment.target.kind !== 'output') continue;
    const conditionMatched = adjustment.condition === undefined ||
      computeInputs[adjustment.condition.field] === adjustment.condition.value;
    const source = unwrap(rawOutputs[adjustment.target.field]);
    if (typeof source !== 'number' || !Number.isFinite(source)) {
      throw new CalculationError({ code: 'BAD_OUTPUT_TYPE', field: adjustment.target.field, message: `Adjustment '${adjustment.id}' requires a finite numeric output.`, expected: 'number' });
    }
    const effective = conditionMatched ? adjustedValue(source, adjustment) : source;
    const existing = rawOutputs[adjustment.target.field];
    rawOutputs[adjustment.target.field] = existing !== null && typeof existing === 'object' && !Array.isArray(existing) && 'value' in existing
      ? { ...existing, value: effective }
      : effective;
    adjustmentEvents[index] = {
      id: adjustment.id,
      target: adjustment.target,
      operation: adjustment.operation,
      original: source,
      effective,
      applied: source !== effective,
      conditionMatched,
      bounds: {
        ...('minimum' in adjustment ? { minimum: adjustment.minimum } : {}),
        ...('maximum' in adjustment ? { maximum: adjustment.maximum } : {}),
      },
      evidenceRefs: adjustment.evidenceRefs,
    };
  }
  const completedAdjustmentEvents = adjustmentEvents.map((event, index) => {
    if (event === undefined) throw new Error(`Adjustment event ${index} was not evaluated.`);
    return event;
  });
  for (const [index, adjustment] of adjustments.entries()) {
    if (adjustment.appliedOutput !== undefined) {
      rawOutputs[adjustment.appliedOutput] = completedAdjustmentEvents[index].applied;
    }
  }
  for (const [index, adjustment] of adjustments.entries()) {
    if (adjustment.verifyOutput === undefined) continue;
    const actual = unwrap(rawOutputs[adjustment.verifyOutput]);
    const expected = completedAdjustmentEvents[index].effective;
    const tolerance = adjustment.verifyTolerance ?? 0;
    const floatingSlack = Number.EPSILON * 16 * Math.max(1, Math.abs(expected));
    if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance + floatingSlack) {
      throw new CalculationError({ code: 'BAD_OUTPUT_TYPE', field: adjustment.verifyOutput, message: `Adjustment '${adjustment.id}' expected '${adjustment.verifyOutput}' to equal ${expected}.`, expected: String(expected) });
    }
  }
  for (const name of Object.keys(rawOutputs)) {
    if (!Object.hasOwn(spec.outputs, name)) throw new CalculationError({ code: 'UNDECLARED_OUTPUT', field: name, message: `${spec.name} produced undeclared output '${name}'.`, expected: Object.keys(spec.outputs).join(' | '), allowed: Object.keys(spec.outputs) });
  }

  const outputs: Record<string, ComputeValue | undefined> = {};
  for (const [name, outputSpec] of Object.entries(spec.outputs)) {
    const value = unwrap(rawOutputs[name]);
    const shouldExist = availabilityShouldBePresent(calculatorId, outputSpec.availability, { inputs: effectiveInputs, outputs } as never);
    if (shouldExist && value === undefined) throw new CalculationError({ code: 'MISSING_OUTPUT', field: name, message: `${spec.name} omitted required output '${name}'.`, expected: expectedOutput(outputSpec) });
    if (!shouldExist && value !== undefined) throw new CalculationError({ code: 'UNEXPECTED_OUTPUT', field: name, message: `${spec.name} produced conditionally unavailable output '${name}'.`, expected: 'output to be absent for these inputs' });
    if (value !== undefined && !validateOutputValue(value, outputSpec)) throw new CalculationError({ code: 'BAD_OUTPUT_TYPE', field: name, message: `${spec.name} produced a malformed '${name}' output.`, expected: expectedOutput(outputSpec) });
    outputs[name] = value;
  }

  const results = Object.entries(spec.outputs).flatMap(([name, output]) => outputs[name] === undefined ? [] : [{ name, title: output.title, value: outputs[name] as ComputeValue, ...(output.unit ? { unit: output.unit } : {}) }]);
  if (results.length === 0) throw new InputError({ field: '(inputs)', message: `${spec.name} produced no outputs for the supplied inputs.`, expected: 'inputs sufficient to produce at least one output' });

  const interpretations: CalcResult['interpretations'] = [];
  const firstPrimary = spec.primaryOutputs.find((name) => outputs[name] !== undefined);
  for (const [name, outputSpec] of Object.entries(spec.outputs)) {
    const value = outputs[name];
    if (value === undefined) continue;
    const supplied = suppliedInterpretation(rawOutputs[name]);
    const bands = outputSpec.interpretationBands ?? (name === firstPrimary ? spec.interpretationBands : undefined);
    const declared = supplied === undefined && bands && (typeof value === 'number' || typeof value === 'string')
      ? evaluateBands(bands, value, effectiveInputs)
      : undefined;
    const band = supplied ?? declared;
    if (band) {
      interpretations.push({ output: name, code: declared?.code ?? 'compute_supplied', kind: declared?.kind ?? 'status', label: band.label, severity: band.severity, evidenceRefs: declared?.evidenceRefs ?? outputSpec.evidenceRefs });
    } else if (bands) warnings.push(`No interpretation band matched output '${name}' (${String(value)}).`);
  }
  const primaryInterpretation = interpretations.find((entry) => entry.output === firstPrimary);

  const scoringComponents = (spec.scoring?.components ?? []).map((component) => {
    const value = effectiveInputs[component.field];
    const input = spec.inputs[component.field];
    if (component.kind === 'boolean') {
      if (typeof value !== 'boolean') throw new CalculationError({ code: 'BAD_OUTPUT_TYPE', field: component.field, message: `Scoring component '${component.field}' requires a boolean value.`, expected: 'boolean' });
      return {
        field: component.field,
        label: input.title,
        value,
        points: value ? component.truePoints : component.falsePoints,
        testable: true,
      };
    }
    if (component.kind === 'threshold') {
      if (typeof value !== 'number') throw new CalculationError({ code: 'BAD_OUTPUT_TYPE', field: component.field, message: `Scoring component '${component.field}' requires a numeric value.`, expected: 'number' });
      const met = component.operator === 'gte' ? value >= component.threshold : value <= component.threshold;
      return {
        field: component.field,
        label: input.title,
        value,
        points: met ? component.truePoints : component.falsePoints,
        testable: true,
      };
    }
    const option = input?.kind === 'enum' ? input.enumValues.find((entry) => entry.value === value) : undefined;
    if (typeof value !== 'string' || option === undefined) throw new CalculationError({ code: 'BAD_OUTPUT_TYPE', field: component.field, message: `Scoring component '${component.field}' has no declared option.`, expected: 'a declared enum option' });
    if (option.scorable === false) return {
      field: component.field,
      label: input.title,
      value,
      testable: false,
      reason: option.notTestableReason,
    };
    if (option.points === undefined) throw new CalculationError({ code: 'BAD_OUTPUT_TYPE', field: component.field, message: `Scoring component '${component.field}' has no declared points.`, expected: 'a scored enum option' });
    return { field: component.field, label: input.title, value, points: option.points, testable: true };
  });
  const declaredMissingReasons = spec.completion === undefined
    ? undefined
    : outputs[spec.completion.missingReasonsOutput];
  const scoreMissingReasons = spec.scoring
    ? scoringComponents.flatMap((component) => component.testable ? [] : [
      `${component.label}: ${component.reason ?? 'not testable'}`,
    ])
    : Array.isArray(declaredMissingReasons) && declaredMissingReasons.every((reason) => typeof reason === 'string')
      ? declaredMissingReasons
      : [];
  const declaredAssessmentComplete = spec.completion === undefined
    ? undefined
    : outputs[spec.completion.completeOutput];
  const scoreComplete = spec.scoring
    ? scoreMissingReasons.length === 0
    : typeof declaredAssessmentComplete === 'boolean'
      ? declaredAssessmentComplete
      : true;
  if (spec.scoring) {
    const score = outputs[spec.scoring.output];
    const componentTotal = scoreComplete
      ? scoringComponents.reduce((total, component) => total + (component.points as number), 0)
      : undefined;
    if ((scoreComplete && (typeof score !== 'number' || score !== componentTotal)) || (!scoreComplete && score !== undefined)) {
      throw new CalculationError({
        code: 'BAD_OUTPUT_TYPE',
        field: spec.scoring.output,
        message: scoreComplete
          ? `${spec.name} score ${String(score)} disagrees with declared component total ${componentTotal}.`
          : `${spec.name} produced a total even though one or more components were not testable.`,
        expected: scoreComplete ? String(componentTotal) : 'score omitted',
      });
    }
  }

  return {
    schemaVersion: '1.1', id: spec.id, version: spec.version, clinicalModel, results,
    ...(primaryInterpretation ? { interpretation: { label: primaryInterpretation.label, severity: primaryInterpretation.severity } } : {}),
    interpretations, warnings, inputsUsed, inputProvenance, adjustments: completedAdjustmentEvents,
    scoringComponents, scoreComplete, scoreMissingReasons,
    evidence: spec.evidence.map((source) => ({ id: source.id, type: source.type, citation: source.citation, locator: source.locator, ...(source.doi ? { doi: source.doi } : {}), ...(source.url ? { url: source.url } : {}) })),
  };
}
