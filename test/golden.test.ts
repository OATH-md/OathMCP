/**
 * Catalog-wide source-derived reference regression net.
 *
 * Authoritative dossier cases, not historical encoded fixtures, own the
 * expected behavior. The scenario gate separately proves the same cases across
 * engine, full direct MCP, and compact MCP surfaces.
 */
import { describe, expect, it } from 'vitest';
import { loadSpecs, outputShouldBePresent, run, type CalculatorId } from '../src/engine/index.js';
import { loadValidationDossiers, type ReferenceCase } from '../src/validation/index.js';

const specs = loadSpecs();
const dossiers = loadValidationDossiers();

function expectClose(actual: unknown, expected: unknown, testCase: ReferenceCase, path: string): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const tolerance = testCase.tolerance.value ?? 0;
    if (testCase.tolerance.mode === 'exact') expect(actual, path).toBe(expected);
    else if (testCase.tolerance.mode === 'absolute') {
      expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(tolerance);
    } else {
      expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(tolerance * Math.abs(expected));
    }
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    if (!Array.isArray(actual)) return;
    expect(actual, path).toHaveLength(expected.length);
    expected.forEach((entry, index) => expectClose(actual[index], entry, testCase, `${path}[${index}]`));
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    expect(typeof actual, path).toBe('object');
    expect(actual, path).not.toBeNull();
    if (typeof actual !== 'object' || actual === null) return;
    for (const [key, entry] of Object.entries(expected)) {
      expectClose((actual as Record<string, unknown>)[key], entry, testCase, `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toEqual(expected);
}

describe('source-derived reference coverage', () => {
  for (const [id, spec] of specs) {
    const references = dossiers.get(id)?.cases.filter(
      (testCase): testCase is ReferenceCase => testCase.kind === 'reference',
    ) ?? [];

    it(`${id} has at least three independently linked reference cases`, () => {
      expect(references.length).toBeGreaterThanOrEqual(3);
      expect(references.every((testCase) =>
        testCase.claimIds.length > 0 && testCase.sourceIds.length > 0 && testCase.witnesses.length > 0)).toBe(true);
    });

    references.forEach((testCase) => {
      it(`${id} — ${testCase.id}`, () => {
        expect(['calculate', 'warn', 'omit']).toContain(testCase.expectedBehavior);
        const result = run(id, testCase.inputs as Record<string, unknown>);
        const byName = Object.fromEntries(result.results.map((entry) => [entry.name, entry.value]));

        for (const [name, expected] of Object.entries(testCase.expected)) {
          expectClose(byName[name], expected, testCase, `${id}.${name}`);
        }
        for (const warning of testCase.expectedWarnings ?? []) expect(result.warnings).toContain(warning);
        for (const interpretation of testCase.expectedInterpretations ?? []) {
          expect(result.interpretations).toContainEqual(expect.objectContaining(interpretation));
        }
        for (const output of testCase.omittedOutputs ?? []) expect(byName).not.toHaveProperty(output);

        const normalizedInputs = Object.fromEntries(
          Object.entries(result.inputsUsed).map(([name, used]) => [name, used.value]),
        );
        const present = new Set(result.results.map((entry) => entry.name));
        for (const outputName of Object.keys(spec.outputs)) {
          expect(present.has(outputName), `conditional presence for '${outputName}'`).toBe(
            outputShouldBePresent(id as CalculatorId, outputName as never, {
              inputs: normalizedInputs as never,
              outputs: byName as never,
            }),
          );
        }
      });
    });
  }
});
