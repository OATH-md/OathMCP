import type { CalcSpec } from '../engine/spec-schema.js';
import type { CaseTag } from './schema.js';

export function requiredCaseTags(spec: CalcSpec): Set<CaseTag> {
  const tags = new Set<CaseTag>(['required-inputs', 'agent-applicability']);
  const inputs = Object.values(spec.inputs);
  if (inputs.some((input) => input.hardLimits !== undefined)) tags.add('hard-limits');
  if (inputs.some((input) => input.plausible !== undefined)) tags.add('plausibility');
  if (inputs.some((input) => input.default !== undefined)) tags.add('defaults');
  if (inputs.some((input) => (input.aliases?.length ?? 0) > 0)) tags.add('aliases');
  if (inputs.some((input) => input.kind === 'quantity')) tags.add('unit-equivalence');
  if ((spec.interpretationBands?.length ?? 0) > 0 || Object.values(spec.outputs).some((output) => (output.interpretationBands?.length ?? 0) > 0)) {
    tags.add('interpretation-boundaries');
  }
  if ((spec.constraints?.length ?? 0) > 0) tags.add('constraints');
  if (spec.prompt !== undefined || inputs.some((input) => !input.required && input.default === undefined)) tags.add('conditional-output');
  tags.add(`calculator:${spec.id}:core`);
  return tags;
}

export function requiredClinicalClaimKeys(spec: CalcSpec): Set<string> {
  const keys = new Set<string>([
    'calculator:model',
    'formula:implementation',
    'applicability:purpose',
  ]);
  if (spec.whenNotToUse !== undefined) keys.add('applicability:exclusions');
  for (const [name, input] of Object.entries(spec.inputs)) {
    keys.add(`input:${name}`);
    if (input.hardLimits !== undefined) keys.add(`input:${name}:hard_limits`);
    if (input.plausible !== undefined) keys.add(`input:${name}:plausibility`);
    if ((input.aliases?.length ?? 0) > 0) keys.add(`input:${name}:aliases`);
    if (input.kind === 'enum') keys.add(`input:${name}:options`);
    if (input.kind === 'quantity') keys.add(`unit:${name}`);
    if (input.default !== undefined) keys.add(`default:${name}`);
  }
  for (const name of Object.keys(spec.outputs)) keys.add(`output:${name}`);
  (spec.constraints ?? []).forEach((_, index) => keys.add(`constraint:${index}`));
  (spec.warnings ?? []).forEach((_, index) => keys.add(`warning:${index}`));
  (spec.interpretationBands ?? []).forEach((_, index) => keys.add(`band:calculator:${index}`));
  for (const [name, output] of Object.entries(spec.outputs)) {
    (output.interpretationBands ?? []).forEach((_, index) => keys.add(`band:${name}:${index}`));
  }
  if (spec.prompt !== undefined) keys.add('interpretation:prompt');
  return keys;
}

export function allowedClaimKindsForKey(key: string): Set<string> {
  const prefix = key.split(':')[0];
  if (key === 'calculator:model') return new Set(['applicability']);
  if (key === 'formula:implementation') return new Set(['formula']);
  const kinds: Record<string, string[]> = {
    applicability: ['applicability', 'exclusion'],
    input: ['input'],
    unit: ['unit'],
    default: ['default'],
    output: ['outcome'],
    constraint: ['input', 'applicability', 'exclusion'],
    warning: ['warning'],
    band: ['band'],
    interpretation: ['interpretation'],
    formula: ['formula'],
    coefficient: ['coefficient'],
    cap: ['cap'],
    cutoff: ['cutoff'],
    recommendation: ['recommendation'],
  };
  return new Set(kinds[prefix] ?? []);
}

export function claimCoverageKeyExists(
  spec: CalcSpec,
  key: string,
  requiredKeys: ReadonlySet<string> = requiredClinicalClaimKeys(spec),
): boolean {
  if (requiredKeys.has(key)) return true;
  const match = /^(coefficient|cap|cutoff|recommendation):([a-z0-9][a-z0-9._-]*)$/.exec(key);
  if (match === null) return false;
  const [, namespace, identifier] = match;
  if (namespace === 'cap') {
    return (spec.adjustments ?? []).some((adjustment) => adjustment.id === identifier);
  }
  if (namespace === 'cutoff') {
    return [
      ...(spec.interpretationBands ?? []),
      ...Object.values(spec.outputs).flatMap((output) => output.interpretationBands ?? []),
    ].some((band) => band.code === identifier);
  }
  // Coefficients and recommendations are not declared by the current runtime
  // spec schema, so accepting a well-shaped invented identifier would reopen
  // the claim-key spoofing bypass. A future authoring phase must add a closed
  // declaration before either namespace can be enrolled.
  return false;
}

export function coverageMustBeExecutable(key: string): boolean {
  if (key === 'calculator:model') return false;
  return true;
}
