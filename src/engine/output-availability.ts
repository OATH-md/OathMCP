import type {
  CalculatorId,
  CalculatorInputsById,
  CalculatorOutputsById,
} from '../compute/types.generated.js';
import { loadSpec } from './load-specs.js';
import type { OutputAvailability } from './spec-schema.js';

export type OutputAvailabilityContext<K extends CalculatorId> = {
  inputs: CalculatorInputsById[K];
  outputs: Partial<CalculatorOutputsById[K]>;
};

type AnyCondition = (context: { inputs: Record<string, unknown>; outputs: Record<string, unknown> }) => boolean;
const CONDITIONS = new Map<string, AnyCondition>();

function key(calculatorId: string, conditionId: string): string {
  return `${calculatorId}:${conditionId}`;
}

export function registerOutputCondition<K extends CalculatorId>(
  calculatorId: K,
  conditionId: string,
  predicate: (context: OutputAvailabilityContext<K>) => boolean,
): void {
  const conditionKey = key(calculatorId, conditionId);
  if (CONDITIONS.has(conditionKey)) {
    throw new Error(`Output condition '${conditionKey}' is already registered.`);
  }
  CONDITIONS.set(conditionKey, predicate as AnyCondition);
}

export function outputShouldBePresent<K extends CalculatorId>(
  calculatorId: K,
  outputId: keyof CalculatorOutputsById[K],
  context: OutputAvailabilityContext<K>,
): boolean {
  const spec = loadSpec(calculatorId);
  const output = spec.outputs[String(outputId)];
  if (output === undefined) throw new Error(`Unknown output '${String(outputId)}' for '${calculatorId}'.`);
  return availabilityShouldBePresent(calculatorId, output.availability, context);
}

export function availabilityShouldBePresent<K extends CalculatorId>(
  calculatorId: K,
  availability: OutputAvailability,
  context: OutputAvailabilityContext<K>,
): boolean {
  if (availability.kind === 'always') return true;
  if (availability.kind === 'whenAnyInputPresent') {
    return availability.fields.some((field) => context.inputs[field as keyof typeof context.inputs] !== undefined);
  }
  if (availability.kind === 'whenAllInputsPresent') {
    return availability.fields.every((field) => context.inputs[field as keyof typeof context.inputs] !== undefined);
  }
  const predicate = CONDITIONS.get(key(calculatorId, availability.conditionId));
  if (predicate === undefined) {
    throw new Error(`Output condition '${calculatorId}:${availability.conditionId}' is not registered.`);
  }
  return predicate(context as Parameters<AnyCondition>[0]);
}

export function registeredOutputConditionIds(calculatorId: string): string[] {
  const prefix = `${calculatorId}:`;
  return [...CONDITIONS.keys()]
    .filter((conditionKey) => conditionKey.startsWith(prefix))
    .map((conditionKey) => conditionKey.slice(prefix.length))
    .sort();
}

export function assertOutputConditionCoverage(
  specs: Iterable<{
    id: string;
    outputs: Record<string, { availability: { kind: string; conditionId?: string } }>;
  }>,
): void {
  const issues: string[] = [];
  for (const spec of specs) {
    const declared = new Set(
      Object.values(spec.outputs)
        .filter((output) => output.availability.kind === 'computeCondition')
        .map((output) => output.availability.conditionId as string),
    );
    const registered = new Set(registeredOutputConditionIds(spec.id));
    for (const conditionId of declared) {
      if (!registered.has(conditionId)) issues.push(`${spec.id}:${conditionId} is not registered`);
    }
    for (const conditionId of registered) {
      if (!declared.has(conditionId)) issues.push(`${spec.id}:${conditionId} is registered but not declared`);
    }
  }
  if (issues.length > 0) throw new Error(`Output condition coverage failed — ${issues.join('; ')}`);
}
