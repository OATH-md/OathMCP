import { run } from '../engine/run.js';
import { EngineError } from '../engine/errors.js';
import type { ValidationCaseRunner } from '../validation/schema.js';
import { connectInMemoryClient } from './in-memory-client.js';

export interface ManagedValidationCaseRunner extends ValidationCaseRunner {
  close(): Promise<void>;
}

class McpValidationError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly expected?: string;
  readonly allowed?: string[];
  readonly min?: number;
  readonly max?: number;

  constructor(payload: {
    code?: unknown;
    field?: unknown;
    error?: unknown;
    expected?: unknown;
    allowed?: unknown;
    min?: unknown;
    max?: unknown;
  }) {
    super(typeof payload.error === 'string' ? payload.error : 'MCP calculation failed');
    this.code = typeof payload.code === 'string' ? payload.code : 'MCP_PROTOCOL_ERROR';
    if (typeof payload.field === 'string') this.field = payload.field;
    if (typeof payload.expected === 'string') this.expected = payload.expected;
    if (Array.isArray(payload.allowed) && payload.allowed.every((entry) => typeof entry === 'string')) {
      this.allowed = payload.allowed;
    }
    if (typeof payload.min === 'number') this.min = payload.min;
    if (typeof payload.max === 'number') this.max = payload.max;
  }
}

type BoundaryFailureKind = 'required' | 'unknown' | 'hard_limit' | 'enum' | 'unit' | 'alias' | 'type';

function schemaBoundaryFailure(
  error: unknown,
  inputs: Readonly<Record<string, unknown>>,
): { kind: BoundaryFailureKind; field: string } | undefined {
  const actual = error as { field?: unknown; message?: unknown };
  const message = typeof actual.message === 'string' ? actual.message : '';
  const required = /Required input: ([a-zA-Z0-9_]+)/.exec(message);
  const unknown = /"keys":\s*\[\s*"([^"]+)"/.exec(message) ??
    /Unrecognized key(?:s)?:?\s*"([^"]+)"/.exec(message);
  const paths = [...message.matchAll(/"path":\s*\[\s*"([^"]+)"/g)];
  const invalidUnion = /"code":\s*"invalid_union"/.test(message);
  const genericInvalidInput = invalidUnion || message === 'Invalid input';
  const path = invalidUnion ? paths[paths.length - 1] : paths[0];
  const structuredField = typeof actual.field === 'string' && actual.field !== '' && actual.field !== 'inputs'
    ? actual.field.split('.')[0]
    : undefined;
  const field = required?.[1] ?? unknown?.[1] ?? path?.[1] ?? structuredField;
  if (field === undefined) return undefined;
  if (required !== null) return { kind: 'required', field };
  // Zod reports a missing canonical (non-alias) input as an invalid type whose
  // received value is undefined. Treat that boundary spelling as the same
  // missing-input discriminant emitted by the engine.
  if (!(field in inputs) && (
    /received undefined/.test(message) ||
    /Invalid option:/.test(message) ||
    genericInvalidInput
  )) {
    return { kind: 'required', field };
  }
  if (unknown !== null) return { kind: 'unknown', field };
  if (/Too (?:small|big):/.test(message) || /Expected [^\n]+–[^\n]+/.test(message)) {
    return { kind: 'hard_limit', field };
  }
  if (/Invalid option:/.test(message)) return { kind: 'enum', field };
  if (/Expected one of:/.test(message)) return { kind: 'unit', field };
  if (/Provide [a-zA-Z0-9_]+ once; do not combine it with compatibility aliases\./.test(message)) {
    return { kind: 'alias', field };
  }
  if (genericInvalidInput || /Invalid input: expected/.test(message)) {
    return { kind: 'type', field };
  }
  return undefined;
}

const ENGINE_CODE_BY_BOUNDARY_KIND: Record<BoundaryFailureKind, string> = {
  required: 'MISSING_REQUIRED',
  unknown: 'UNKNOWN_INPUT',
  hard_limit: 'OUT_OF_HARD_LIMITS',
  enum: 'BAD_ENUM',
  unit: 'UNKNOWN_UNIT',
  alias: 'AMBIGUOUS_ALIAS',
  type: 'BAD_TYPE',
};

export function throwClinicalSurfaceFailure(
  calculatorId: string,
  inputs: Record<string, unknown>,
  mcpError: unknown,
): never {
  const boundary = schemaBoundaryFailure(mcpError, inputs);
  if (boundary === undefined) throw mcpError;
  let engineError: EngineError | undefined;
  try {
    run(calculatorId, structuredClone(inputs));
  } catch (error) {
    if (error instanceof EngineError) engineError = error;
  }
  if (engineError === undefined) throw mcpError;
  if (boundary.field === engineError.field &&
      ENGINE_CODE_BY_BOUNDARY_KIND[boundary.kind] === engineError.code) {
    throw engineError;
  }
  // Engine-originated MCP errors retain their actual message and metadata so
  // the case runner can compare the complete payload without canonicalization
  // hiding drift. Unrecognized or incongruent boundary errors also fail raw.
  throw mcpError;
}

async function callClinicalSurface<T>(
  calculatorId: string,
  inputs: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throwClinicalSurfaceFailure(calculatorId, inputs, error);
  }
}

function clinicalPayload(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const { evidenceUri: _evidenceUri, ...payload } = value as Record<string, unknown>;
  return payload;
}

export async function createValidationCaseRunner(): Promise<ManagedValidationCaseRunner> {
  const connections = await Promise.allSettled([
    connectInMemoryClient('oath-clinical-validation-full', { mode: 'full' }),
    connectInMemoryClient('oath-clinical-validation-compact', { mode: 'compact' }),
  ]);
  const failed = connections.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    await Promise.allSettled(connections
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof connectInMemoryClient>>> =>
        result.status === 'fulfilled')
      .map((result) => result.value.close()));
    throw failed.reason;
  }
  const [full, compact] = connections.map((result) => {
    if (result.status !== 'fulfilled') throw new Error('unreachable rejected validation connection');
    return result.value;
  }) as [
    Awaited<ReturnType<typeof connectInMemoryClient>>,
    Awaited<ReturnType<typeof connectInMemoryClient>>,
  ];
  return {
    runEngine: async (calculatorId, inputs) => run(calculatorId, inputs),
    runFullMcp: async (calculatorId, inputs) => {
      const result = await callClinicalSurface(calculatorId, inputs, () =>
        full.client.callTool({ name: `calculate_${calculatorId}`, arguments: inputs }));
      if (result.isError) {
        const first = (result.content as { type: string; text?: string }[])[0];
        let payload: ConstructorParameters<typeof McpValidationError>[0] = {};
        if (first !== undefined && first.type === 'text' && first.text !== undefined) {
          try {
            payload = JSON.parse(first.text) as typeof payload;
          } catch {
            payload = { error: first.text };
          }
        }
        throwClinicalSurfaceFailure(calculatorId, inputs, new McpValidationError(payload));
      }
      return clinicalPayload(result.structuredContent);
    },
    runCompactMcp: async (calculatorId, inputs) => {
      const response = await callClinicalSurface(calculatorId, inputs, () =>
        compact.client.callTool({
          name: 'calculate',
          arguments: { id: calculatorId, inputs },
        }));
      const entry = (response.structuredContent as {
        result?: {
          ok?: boolean;
          result?: unknown;
          error?: ConstructorParameters<typeof McpValidationError>[0];
        };
      } | undefined)?.result;
      if (entry?.ok !== true) {
        throwClinicalSurfaceFailure(calculatorId, inputs, new McpValidationError(entry?.error ?? {}));
      }
      return clinicalPayload(entry.result);
    },
    close: async () => {
      await Promise.allSettled([full.close(), compact.close()]);
    },
  };
}
