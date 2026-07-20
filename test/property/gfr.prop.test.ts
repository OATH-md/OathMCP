/**
 * GFR property tests (fast-check) — invariants that must hold for every valid
 * input, derived directly from the equation's clinical and numeric contract.
 *
 *   1. eGFR is always positive.
 *   2. eGFR is monotonically non-increasing in creatinine (fixed age/sex):
 *      higher creatinine never yields a higher eGFR. (Equality can occur only
 *      when two nearby creatinines round to the same 2-decimal result.)
 *   3. An SI creatinine input equals its equivalent canonical (US) input, so the
 *      per-value unit path introduces no discrepancy beyond 2-decimal rounding.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { run } from '../../src/engine/index.js';

const sex = fc.constantFrom('male', 'female');

function egfr(creatinine: number, age: number, s: string): number {
  return run('gfr', { creatinine, age, sex: s }).results[0].value as number;
}

describe('gfr — properties', () => {
  it('always returns a positive eGFR', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.2, max: 20, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 18, max: 120 }),
        sex,
        (creatinine, age, s) => {
          expect(egfr(creatinine, age, s)).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is monotonically non-increasing in creatinine', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.2, max: 13, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.5, max: 7, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 18, max: 120 }),
        sex,
        (low, delta, age, s) => {
          const high = low + delta;
          expect(egfr(high, age, s)).toBeLessThanOrEqual(egfr(low, age, s));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('treats an SI creatinine input as equal to its canonical (US) equivalent', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.2, max: 20, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 18, max: 120 }),
        sex,
        (creatinine, age, s) => {
          const bare = egfr(creatinine, age, s);
          // Independent literal anchor: 1 mg/dL creatinine = 88.4 µmol/L.
          // Do not use the production conversion table as its own oracle.
          const siValue = creatinine * 88.4;
          const si = run('gfr', {
            creatinine: { value: siValue, unit: 'umol/L' },
            age,
            sex: s,
          }).results[0].value as number;
          // Both round to 2 decimals; SI passes through a ×88.4/÷88.4 round-trip,
          // so allow a single-ULP rounding difference.
          expect(Math.abs(si - bare)).toBeLessThanOrEqual(0.01);
        },
      ),
      { numRuns: 100 },
    );
  });
});
