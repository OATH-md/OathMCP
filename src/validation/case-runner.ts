import type {
  CaseExecutionResult,
  ReviewIssue,
  ValidationCase,
  ValidationCaseRunner,
  ValidationDossier,
} from './schema.js';

interface ObservedResult {
  outputs: Record<string, unknown>;
  warnings: string[];
  interpretations: Array<{
    output: string;
    code: string;
    kind: string;
    label: string;
    severity: string;
  }>;
}

interface NormalizedError {
  code?: unknown;
  field?: unknown;
  message?: unknown;
  expected?: unknown;
  allowed?: unknown;
  min?: unknown;
  max?: unknown;
}

type SurfaceName = 'engine' | 'full_mcp' | 'compact_mcp';
const MAX_CONCURRENT_CASES = 8;
type SurfaceOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: NormalizedError };

function observedResult(value: unknown): ObservedResult | undefined {
  if (typeof value !== 'object' || value === null || !('results' in value)) return undefined;
  const result = value as { results?: { name: string; value: unknown }[] };
  const warnings = 'warnings' in value && Array.isArray(value.warnings)
    ? value.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const interpretations = 'interpretations' in value && Array.isArray(value.interpretations)
    ? value.interpretations.filter((entry): entry is ObservedResult['interpretations'][number] =>
      typeof entry === 'object' && entry !== null &&
      typeof (entry as { output?: unknown }).output === 'string' &&
      typeof (entry as { code?: unknown }).code === 'string' &&
      typeof (entry as { kind?: unknown }).kind === 'string' &&
      typeof (entry as { label?: unknown }).label === 'string' &&
      typeof (entry as { severity?: unknown }).severity === 'string')
    : [];
  return {
    outputs: Object.fromEntries((result.results ?? []).map((entry) => [entry.name, entry.value])),
    warnings,
    interpretations,
  };
}

function closeEnough(actual: unknown, expected: unknown, testCase: ValidationCase): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (testCase.tolerance.mode === 'exact') return Object.is(actual, expected);
    const tolerance = testCase.tolerance.value ?? 0;
    return testCase.tolerance.mode === 'absolute'
      ? Math.abs(actual - expected) <= tolerance
      : Math.abs(actual - expected) <= tolerance * Math.abs(expected);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((entry, index) => closeEnough(entry, expected[index], testCase));
  }
  if (typeof actual === 'object' && actual !== null && typeof expected === 'object' && expected !== null) {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord);
    return Object.keys(actualRecord).length === expectedKeys.length &&
      expectedKeys.every((key) => Object.hasOwn(actualRecord, key) &&
        closeEnough(actualRecord[key], expectedRecord[key], testCase));
  }
  return Object.is(actual, expected);
}

function matchesExpected(value: unknown, testCase: ValidationCase): boolean {
  const observed = observedResult(value);
  if (observed === undefined) return false;
  const outputsMatch = Object.entries(testCase.expected).every(([key, expected]) =>
    closeEnough(observed.outputs[key], expected, testCase));
  const interpretationsMatch = (testCase.expectedInterpretations ?? []).every((expected) =>
    observed.interpretations.some((actual) =>
      actual.output === expected.output &&
      actual.code === expected.code &&
      actual.kind === expected.kind &&
      actual.label === expected.label &&
      actual.severity === expected.severity));
  return outputsMatch && interpretationsMatch;
}

function normalizedError(error: unknown): NormalizedError {
  if (typeof error !== 'object' || error === null) return { message: String(error) };
  const actual = error as NormalizedError & { error?: unknown };
  return Object.fromEntries(Object.entries({
    code: actual.code,
    field: actual.field,
    message: actual.message ?? actual.error,
    expected: actual.expected,
    allowed: actual.allowed,
    min: actual.min,
    max: actual.max,
  }).filter(([, value]) => value !== undefined));
}

function matchesError(error: NormalizedError, testCase: ValidationCase): boolean {
  const expected = testCase.expectedError;
  if (expected === undefined) return false;
  return error.code === expected.code &&
    error.field === expected.field &&
    (expected.messageIncludes === undefined ||
      error.message === expected.messageIncludes);
}

function matchesSuccessBehavior(value: unknown, testCase: ValidationCase): boolean {
  const observed = observedResult(value);
  if (observed === undefined || !matchesExpected(value, testCase)) return false;
  if (testCase.expectedBehavior === 'warn') {
    return JSON.stringify(observed.warnings) === JSON.stringify(testCase.expectedWarnings ?? []);
  }
  if (observed.warnings.length > 0) return false;
  if (testCase.expectedBehavior === 'omit') {
    return (testCase.omittedOutputs ?? []).every((output) => !Object.hasOwn(observed.outputs, output));
  }
  return testCase.expectedBehavior === 'calculate';
}

function normalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalizePayload(entry)]));
}

function canonicalOutcome(outcome: SurfaceOutcome): string {
  return JSON.stringify(outcome.ok
    ? { ok: true, payload: normalizePayload(outcome.payload) }
    : { ok: false, error: normalizePayload(outcome.error) });
}

async function observe(operation: () => Promise<unknown>): Promise<SurfaceOutcome> {
  try {
    return { ok: true, payload: await operation() };
  } catch (error) {
    return { ok: false, error: normalizedError(error) };
  }
}

function surfaceMatches(outcome: SurfaceOutcome, testCase: ValidationCase): boolean {
  if (['reject', 'clarify'].includes(testCase.expectedBehavior)) {
    return !outcome.ok && matchesError(outcome.error, testCase);
  }
  return outcome.ok && matchesSuccessBehavior(outcome.payload, testCase);
}

async function executeOne(
  calculatorId: string,
  testCase: ValidationCase,
  runner: ValidationCaseRunner,
): Promise<CaseExecutionResult> {
  const operations: Array<[SurfaceName, () => Promise<unknown>]> = [
    ['engine', () => runner.runEngine(calculatorId, structuredClone(testCase.inputs))],
    ['full_mcp', () => runner.runFullMcp(calculatorId, structuredClone(testCase.inputs))],
    ['compact_mcp', () => runner.runCompactMcp(calculatorId, structuredClone(testCase.inputs))],
  ];
  const outcomes = new Map<SurfaceName, SurfaceOutcome>();
  const surfacePasses = new Map<SurfaceName, boolean>();
  const issues: ReviewIssue[] = [];

  const observed = await Promise.all(operations.map(async ([surface, operation]) => [
    surface,
    await observe(operation),
  ] as const));
  for (const [surface, outcome] of observed) {
    outcomes.set(surface, outcome);
    const passed = surfaceMatches(outcome, testCase);
    surfacePasses.set(surface, passed);
    if (!passed) {
      issues.push({
        code: `case.${surface}.mismatch`,
        message: `${surface} outcome did not match the frozen expectation`,
        severity: 'error',
        calculatorId,
        path: testCase.id,
      });
    }
  }

  const parityPassed = new Set([...outcomes.values()].map(canonicalOutcome)).size === 1;
  if (!parityPassed) {
    issues.push({
      code: 'case.surface_parity',
      message: 'engine, full direct MCP, and compact MCP clinical outcomes differ',
      severity: 'error',
      calculatorId,
      path: testCase.id,
    });
  }

  const enginePassed = surfacePasses.get('engine') === true;
  const fullMcpPassed = surfacePasses.get('full_mcp') === true;
  const compactMcpPassed = surfacePasses.get('compact_mcp') === true;
  const passed = enginePassed && fullMcpPassed && compactMcpPassed && parityPassed;
  return {
    caseId: testCase.id,
    status: passed ? 'passed' : 'failed',
    enginePassed,
    fullMcpPassed,
    compactMcpPassed,
    parityPassed,
    issues,
  };
}

export async function executeValidationCases(
  dossier: ValidationDossier,
  runner: ValidationCaseRunner,
): Promise<ReadonlyMap<string, CaseExecutionResult>> {
  const entries = new Array<readonly [string, CaseExecutionResult]>(dossier.cases.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_CASES, dossier.cases.length) },
    async () => {
      while (nextIndex < dossier.cases.length) {
        const index = nextIndex++;
        const testCase = dossier.cases[index];
        entries[index] = [
          testCase.id,
          await executeOne(dossier.calculatorId, testCase, runner),
        ];
      }
    },
  );
  await Promise.all(workers);
  return new Map(entries);
}
