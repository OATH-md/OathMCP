import { matchesWhen } from './bands.js';
import { InputError } from './errors.js';
import type { CalcSpec } from './spec-schema.js';

type Value = number | string | boolean;

const COMPARATORS: Record<
  '<' | '<=' | '>' | '>=' | '==' | '!=',
  (left: Value, right: Value) => boolean
> = {
  '<': (left, right) => Number(left) < Number(right),
  '<=': (left, right) => Number(left) <= Number(right),
  '>': (left, right) => Number(left) > Number(right),
  '>=': (left, right) => Number(left) >= Number(right),
  '==': (left, right) => left === right,
  '!=': (left, right) => left !== right,
};

/** Enforce a spec's closed set of cross-field input constraints. */
export function enforceConstraints(
  spec: CalcSpec,
  inputs: Record<string, Value>,
): void {
  const matchesWhere = (where: Array<{ field: string; when: string }> | undefined): boolean =>
    where?.every((condition) => {
      const value = inputs[condition.field];
      return value !== undefined && matchesWhen(condition.when, value);
    }) ?? true;
  for (const constraint of spec.constraints ?? []) {
    if (constraint.kind === 'atLeastOne') {
      if (!constraint.fields.some((field) => inputs[field] !== undefined)) {
        throw new InputError({
          code: 'CONSTRAINT_FAILED',
          field: constraint.fields.join(' | '),
          message: constraint.message,
          expected: `at least one of: ${constraint.fields.join(', ')}`,
          allowed: constraint.fields,
        });
      }
      continue;
    }

    if (constraint.kind === 'requiredWhen') {
      const trigger = inputs[constraint.field];
      if (
        trigger !== undefined &&
        matchesWhen(constraint.when, trigger) &&
        constraint.required.some((field) => inputs[field] === undefined)
      ) {
        throw new InputError({
          code: 'CONSTRAINT_FAILED',
          field: constraint.required.join(' | '),
          message: constraint.message,
          expected: `required fields: ${constraint.required.join(', ')}`,
          allowed: constraint.required,
        });
      }
      continue;
    }

    if (constraint.kind === 'requireValueWhen') {
      const trigger = inputs[constraint.field];
      if (
        trigger !== undefined &&
        matchesWhen(constraint.when, trigger) &&
        matchesWhere(constraint.where) &&
        inputs[constraint.target] !== constraint.value
      ) {
        throw new InputError({
          code: 'CONSTRAINT_FAILED',
          field: constraint.target,
          message: constraint.message,
          expected: `${constraint.target} = ${String(constraint.value)}`,
          allowed: [String(constraint.value)],
        });
      }
      continue;
    }

    if (constraint.kind === 'forbidValueWhen') {
      const trigger = inputs[constraint.field];
      if (
        trigger !== undefined &&
        matchesWhen(constraint.when, trigger) &&
        matchesWhere(constraint.where) &&
        inputs[constraint.target] === constraint.value
      ) {
        throw new InputError({
          code: 'CONSTRAINT_FAILED',
          field: constraint.target,
          message: constraint.message,
          expected: `${constraint.target} != ${String(constraint.value)}`,
        });
      }
      continue;
    }

    if (constraint.kind === 'requireAtLeastValuesWhen') {
      const trigger = inputs[constraint.field];
      const matched = constraint.targets.filter((target) => inputs[target.field] === target.value).length;
      if (
        trigger !== undefined &&
        matchesWhen(constraint.when, trigger) &&
        matched < (constraint.minimum ?? 1)
      ) {
        throw new InputError({
          code: 'CONSTRAINT_FAILED',
          field: constraint.field,
          message: constraint.message,
          expected: `at least ${constraint.minimum ?? 1} of: ${constraint.targets.map((target) => `${target.field} = ${String(target.value)}`).join(' | ')}`,
        });
      }
      continue;
    }

    if (constraint.kind === 'forbidPresentWhen') {
      const trigger = inputs[constraint.field];
      const supplied = constraint.forbidden.find((field) => inputs[field] !== undefined);
      if (trigger !== undefined && matchesWhen(constraint.when, trigger) && supplied !== undefined) {
        throw new InputError({
          code: 'CONSTRAINT_FAILED',
          field: supplied,
          message: constraint.message,
          expected: `${supplied} to be omitted`,
        });
      }
      continue;
    }

    const left = inputs[constraint.left];
    const right = inputs[constraint.right];
    if (
      left !== undefined &&
      right !== undefined &&
      !COMPARATORS[constraint.operator](left, right)
    ) {
      throw new InputError({
        code: 'CONSTRAINT_FAILED',
        field: constraint.left,
        message: constraint.message,
        expected: `${constraint.left} ${constraint.operator} ${constraint.right}`,
      });
    }
  }
}
