/**
 * Typed engine errors. Each carries `{ field, message, expected }` so the server
 * layer can relay a machine-readable payload the calling agent can act on
 * (which input, what was wrong, what range/shape was expected).
 */

export const ENGINE_ERROR_CODES = [
  'MISSING_REQUIRED',
  'BAD_TYPE',
  'BAD_ENUM',
  'UNKNOWN_UNIT',
  'UNKNOWN_CALCULATOR',
  'OUT_OF_HARD_LIMITS',
  'CONSTRAINT_FAILED',
  'AMBIGUOUS_ALIAS',
  'UNKNOWN_INPUT',
  'UNDECLARED_OUTPUT',
  'MISSING_OUTPUT',
  'UNEXPECTED_OUTPUT',
  'BAD_OUTPUT_TYPE',
  'NON_FINITE_OUTPUT',
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export interface EngineErrorDetail {
  field: string;
  message: string;
  expected: string;
  code?: EngineErrorCode;
  allowed?: string[];
  min?: number;
  max?: number;
}

export abstract class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly field: string;
  readonly expected: string;
  readonly allowed?: string[];
  readonly min?: number;
  readonly max?: number;

  constructor(detail: EngineErrorDetail, fallbackCode: EngineErrorCode) {
    super(detail.message);
    this.name = new.target.name;
    this.code = detail.code ?? fallbackCode;
    this.field = detail.field;
    this.expected = detail.expected;
    this.allowed = detail.allowed;
    this.min = detail.min;
    this.max = detail.max;
  }
}

/** An input is the wrong kind/shape (missing required, non-numeric, bad enum, unknown unit). */
export class InputError extends EngineError {
  constructor(detail: EngineErrorDetail) {
    super(detail, 'BAD_TYPE');
  }
}

/** An input is outside its hard limits — physiologically impossible; computation is refused. */
export class HardLimitError extends EngineError {
  constructor(detail: EngineErrorDetail) {
    super(detail, 'OUT_OF_HARD_LIMITS');
  }
}

/** A compute function violated the declared output contract. */
export class CalculationError extends EngineError {
  constructor(detail: EngineErrorDetail) {
    super(detail, 'NON_FINITE_OUTPUT');
  }
}
