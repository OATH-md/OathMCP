/** Typed compute registry with one deliberately erased storage boundary. */
import type {
  CalculatorId,
  CalculatorInputsById,
  CalculatorOutputsById,
  ComputeValue,
} from '../compute/types.generated.js';

export type ComputeInputs = Record<string, number | string | boolean>;
export interface ComputedValue {
  value: ComputeValue;
  interpretation?: {
    label: string;
    severity: 'normal' | 'borderline' | 'abnormal' | 'critical';
  };
}
export type ComputeOutputs = Record<string, ComputeValue | ComputedValue | undefined>;
export type ComputeFn = (inputs: ComputeInputs) => ComputeOutputs;

type AnyCompute = (inputs: Record<string, unknown>) => Record<string, ComputeValue | ComputedValue | undefined>;
const COMPUTE = new Map<string, AnyCompute>();

export function registerCompute<K extends CalculatorId>(
  id: K,
  fn: (inputs: CalculatorInputsById[K]) => CalculatorOutputsById[K],
): void {
  if (COMPUTE.has(id)) throw new Error(`Compute function already registered for '${id}'`);
  COMPUTE.set(id, fn as unknown as AnyCompute);
}

export function getCompute<K extends CalculatorId>(
  id: K,
): (inputs: CalculatorInputsById[K]) => CalculatorOutputsById[K];
export function getCompute(id: string): ComputeFn;
export function getCompute(id: string): AnyCompute {
  const fn = COMPUTE.get(id);
  if (fn === undefined) throw new Error(`No compute function registered for '${id}'`);
  return fn;
}

export function getRegisteredComputeIds(): string[] {
  return [...COMPUTE.keys()].sort();
}
