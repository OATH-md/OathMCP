/**
 * Engine barrel — the public entry point of the calculation engine (the `.`
 * subpath export). Server and CLI layers import from here.
 */
export { run, validateOutputValue, clinicalModelProvenance } from './run.js';
export type { CalcResult, ResultValue, UsedInput, InputProvenance, RawInputs } from './run.js';
export { loadSpecs, loadSpec, primeSpecs } from './load-specs.js';
export { convert, isKnownUnit, resolveUnit, ANALYTES } from './units.js';
export { registerCompute, getCompute, getRegisteredComputeIds } from './registry.js';
export { assertComputeCoverage, assertSharedInputCompatibility } from './lint-specs.js';
export { evaluateBands } from './bands.js';
export { registerOutputCondition, outputShouldBePresent, assertOutputConditionCoverage } from './output-availability.js';
export type { OutputAvailabilityContext } from './output-availability.js';
export type { CalculatorId, CalculatorInputsById, CalculatorOutputsById, ComputeValue } from '../compute/types.generated.js';
export { enforceConstraints } from './constraints.js';
export { SpecSchema } from './spec-schema.js';
export type { CalcSpec, InputSpec, OutputSpec, Band } from './spec-schema.js';
export {
  EngineError,
  InputError,
  HardLimitError,
  CalculationError,
  ENGINE_ERROR_CODES,
  type EngineErrorDetail,
  type EngineErrorCode,
} from './errors.js';
