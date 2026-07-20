/** Catalog-wide invariants exercised from each calculator's declared vectors. */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  convert,
  EngineError,
  enforceConstraints,
  loadSpecs,
  run,
  type CalcResult,
  type CalcSpec,
  type InputSpec,
} from '../../src/engine/index.js';
import { loadAuthoritativeReferenceCases } from '../../src/validation/index.js';

const specs = loadSpecs();
const vectorsFor = (id: string) => loadAuthoritativeReferenceCases(id);

function primaryOutputName(spec: CalcSpec): string | undefined {
  return spec.primaryOutputs[0];
}

function assertResultContract(spec: CalcSpec, result: CalcResult, context: string): void {
  expect(result.schemaVersion, context).toBe('1.1');
  expect(result.results.length, context).toBeGreaterThan(0);
  for (const output of result.results) {
    if (typeof output.value === 'number') {
      expect(Number.isFinite(output.value), `${context}: ${output.name}`).toBe(true);
    }
  }

  const primary = primaryOutputName(spec);
  const interpreted = new Set(
    (result.interpretations ?? []).map((entry) => entry.output),
  );
  for (const output of result.results) {
    const bands =
      spec.outputs[output.name]?.interpretationBands ??
      (output.name === primary ? spec.interpretationBands : undefined);
    if (bands !== undefined) {
      expect(
        interpreted.has(output.name),
        `${context}: declared bands did not stage '${output.name}'`,
      ).toBe(true);
    }
  }
  expect(
    result.warnings.filter((warning) =>
      warning.startsWith('No interpretation band matched output'),
    ),
    context,
  ).toEqual([]);
}

function boundaryValues(input: InputSpec): number[] {
  const ranges = [input.hardLimits, input.plausible].filter(
    (range): range is [number, number] => range !== undefined,
  );
  const values = ranges.flatMap(([lower, upper]) =>
    input.kind === 'integer'
      ? [Math.ceil(lower), Math.floor(upper)]
      : [lower, upper],
  );
  return [...new Set(values.filter(Number.isFinite))];
}

function inputArbitrary(input: InputSpec): fc.Arbitrary<unknown> {
  switch (input.kind) {
    case 'boolean':
      return fc.boolean();
    case 'enum': {
      const values = (input.enumValues ?? []).map((entry) => entry.value);
      if (values.length === 0) {
        throw new Error('Cannot derive an arbitrary from an enum with no values.');
      }
      return fc.constantFrom(...values);
    }
    case 'integer': {
      const [lower, upper] = input.plausible ?? input.hardLimits ?? [];
      if (lower === undefined || upper === undefined) {
        throw new Error('Cannot derive an integer arbitrary without a declared range.');
      }
      return fc.integer({ min: Math.ceil(lower), max: Math.floor(upper) });
    }
    case 'number':
    case 'quantity': {
      const [lower, upper] = input.plausible ?? input.hardLimits ?? [];
      if (lower === undefined || upper === undefined) {
        throw new Error('Cannot derive a numeric arbitrary without a declared range.');
      }
      return fc.double({
        min: lower,
        max: upper,
        noNaN: true,
        noDefaultInfinity: true,
      });
    }
  }
}

/**
 * Generate the complete canonical input shape for a spec. Optional values are
 * deliberately included so conditional-required constraints are exercised;
 * declared cross-field constraints are filtered before the engine property is
 * evaluated, rather than being mistaken for calculator failures.
 */
function specInputArbitrary(spec: CalcSpec): fc.Arbitrary<Record<string, unknown>> {
  const fields = Object.fromEntries(
    Object.entries(spec.inputs).map(([name, input]) => [
      name,
      inputArbitrary(input),
    ]),
  ) as Record<string, fc.Arbitrary<unknown>>;

  return fc.record(fields).filter((inputs) => {
    try {
      enforceConstraints(
        spec,
        inputs as Record<string, number | string | boolean>,
      );
      return true;
    } catch (error) {
      if (error instanceof EngineError && error.code === 'CONSTRAINT_FAILED') {
        return false;
      }
      throw error;
    }
  });
}

describe('calculator catalog — universal properties', () => {
  for (const [catalogIndex, [id, spec]] of [...specs].entries()) {
    it(`${id} accepts generated valid inputs deterministically`, () => {
      fc.assert(
        fc.property(specInputArbitrary(spec), (inputs) => {
          const first = run(id, inputs);
          const second = run(id, structuredClone(inputs));

          expect(second).toEqual(first);
          assertResultContract(spec, first, `${id} generated input`);
        }),
        { numRuns: 25, seed: 0x0a7c0000 + catalogIndex },
      );
    });

    it(`${id} is deterministic and emits only finite numeric results`, () => {
      for (const vector of vectorsFor(id)) {
        const inputs = vector.inputs as Record<string, unknown>;
        const first = run(id, inputs);
        const second = run(id, structuredClone(inputs));

        expect(second).toEqual(first);
        assertResultContract(spec, first, `${id} source-derived reference case`);
      }
    });

    for (const [inputName, inputSpec] of Object.entries(spec.inputs)) {
      if (!['number', 'integer', 'quantity'].includes(inputSpec.kind)) continue;
      const candidates = boundaryValues(inputSpec);
      if (candidates.length === 0) continue;

      it(`${id}.${inputName} accepts at least one declared boundary deterministically`, () => {
        const seed = structuredClone(
          vectorsFor(id)[0]?.inputs ?? {},
        ) as Record<string, unknown>;
        let validSamples = 0;

        for (const boundary of candidates) {
          const inputs = { ...seed, [inputName]: boundary };
          let first: CalcResult;
          try {
            first = run(id, inputs);
          } catch (error) {
            // A one-field boundary mutation can legitimately violate a declared
            // relationship to another field. Other failures remain actionable.
            if (
              error instanceof EngineError &&
              error.code === 'CONSTRAINT_FAILED'
            ) {
              continue;
            }
            throw error;
          }

          validSamples += 1;
          expect(run(id, structuredClone(inputs))).toEqual(first);
          assertResultContract(
            spec,
            first,
            `${id}.${inputName} boundary ${boundary}`,
          );
        }

        expect(
          validSamples,
          `${id}.${inputName}: all declared boundary candidates violated constraints`,
        ).toBeGreaterThan(0);
      });
    }

    for (const [inputName, inputSpec] of Object.entries(spec.inputs)) {
      if (inputSpec.kind !== 'quantity') continue;
      const quantity = inputSpec.quantity;
      if (quantity === undefined) continue;

      it(`${id}.${inputName} is equivalent in every accepted unit`, () => {
        const vector = vectorsFor(id).find(
          (candidate) => candidate.inputs[inputName] !== undefined,
        );
        expect(vector, `missing quantity fixture for ${id}.${inputName}`).toBeDefined();
        if (vector === undefined) return;

        const raw = vector.inputs[inputName];
        let canonicalValue: number;
        if (typeof raw === 'number') {
          canonicalValue = raw;
        } else {
          const supplied = raw as { value: number; unit: string };
          canonicalValue = convert(
            quantity.analyte,
            supplied.value,
            supplied.unit,
            quantity.canonicalUnit,
          );
        }

        const canonicalInputs = {
          ...(vector.inputs as Record<string, unknown>),
          [inputName]: canonicalValue,
        };
        const canonical = run(id, canonicalInputs);

        for (const unit of quantity.acceptedUnits) {
          const convertedValue = convert(
            quantity.analyte,
            canonicalValue,
            quantity.canonicalUnit,
            unit,
          );
          const converted = run(id, {
            ...canonicalInputs,
            [inputName]: { value: convertedValue, unit },
          });

          expect(converted.results.map((result) => result.name)).toEqual(
            canonical.results.map((result) => result.name),
          );
          for (const expected of canonical.results) {
            const actual = converted.results.find(
              (result) => result.name === expected.name,
            );
            expect(actual, `${id}.${inputName} in ${unit}: ${expected.name}`).toBeDefined();
            if (
              actual !== undefined &&
              typeof expected.value === 'number' &&
              typeof actual.value === 'number'
            ) {
              expect(actual.value).toBeCloseTo(expected.value, 10);
            } else {
              expect(actual?.value).toEqual(expected.value);
            }
          }
          expect(converted.interpretation).toEqual(canonical.interpretation);
          expect(converted.interpretations).toEqual(canonical.interpretations);
        }
      });
    }
  }
});
