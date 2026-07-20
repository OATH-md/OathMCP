/**
 * Scoring helpers for enum-score and boolean-criteria calculators.
 *
 * Point values are declared data in the spec (`enumValues[].points`), never
 * parsed from a display label at runtime. These helpers read the loaded spec as
 * the single source of truth, so a compute function never restates a point table.
 */
import { loadSpec } from '../engine/load-specs.js';
import type { CalculatorId, CalculatorInputsById } from './types.generated.js';

export interface ScoreComponent {
  field: string;
  label: string;
  value: string | number | boolean;
  points?: number;
  testable: boolean;
  reason?: string;
}

export interface ScoreBreakdown {
  complete: boolean;
  components: ScoreComponent[];
  missingReasons: string[];
}

export function scoreBreakdown<K extends CalculatorId>(
  id: K,
  inputs: CalculatorInputsById[K],
): ScoreBreakdown {
  const spec = loadSpec(id);
  const components = (spec.scoring?.components ?? []).map((component): ScoreComponent => {
    const input = spec.inputs[component.field];
    const value = inputs[component.field as keyof CalculatorInputsById[K]];
    if (component.kind === 'boolean') {
      if (typeof value !== 'boolean' || input?.kind !== 'boolean') {
        throw new Error(`Invalid boolean scoring component ${id}.${component.field}`);
      }
      return {
        field: component.field,
        label: input.title,
        value,
        points: value ? component.truePoints : component.falsePoints,
        testable: true,
      };
    }
    if (component.kind === 'threshold') {
      if (typeof value !== 'number' || input === undefined || !['number', 'integer', 'quantity'].includes(input.kind)) {
        throw new Error(`Invalid threshold scoring component ${id}.${component.field}`);
      }
      const met = component.operator === 'gte' ? value >= component.threshold : value <= component.threshold;
      return {
        field: component.field,
        label: input.title,
        value,
        points: met ? component.truePoints : component.falsePoints,
        testable: true,
      };
    }
    if (typeof value !== 'string' || input?.kind !== 'enum') {
      throw new Error(`Invalid enum scoring component ${id}.${component.field}`);
    }
    const option = input.enumValues.find((entry) => entry.value === value);
    if (option === undefined) throw new Error(`Unknown scoring option ${id}.${component.field} = '${value}'`);
    if (option.scorable === false) {
      return {
        field: component.field,
        label: input.title,
        value,
        testable: false,
        reason: option.notTestableReason,
      };
    }
    if (option.points === undefined) throw new Error(`No points declared for ${id}.${component.field} = '${value}'`);
    return { field: component.field, label: input.title, value, points: option.points, testable: true };
  });
  const missingReasons = components.flatMap((component) => component.testable ? [] : [
    `${component.label}: ${component.reason ?? 'not testable'}`,
  ]);
  return { complete: missingReasons.length === 0, components, missingReasons };
}

export function sumDeclaredScore<K extends CalculatorId>(
  id: K,
  inputs: CalculatorInputsById[K],
): { total?: number; complete: boolean; components: ScoreComponent[]; missingReasons: string[] } {
  const breakdown = scoreBreakdown(id, inputs);
  return {
    ...breakdown,
    ...(breakdown.complete
      ? { total: breakdown.components.reduce((total, component) => total + (component.points as number), 0) }
      : {}),
  };
}
