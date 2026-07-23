import { describe, it, expect } from 'vitest';
import { ANALYTES, convert, isKnownUnit, resolveUnit } from './units.js';

describe('unit conversion', () => {
  it('round-trips creatinine mg/dL -> umol/L -> mg/dL', () => {
    const si = convert('creatinine', 1.2, 'mg/dL', 'umol/L');
    expect(si).toBeCloseTo(106.08, 2);
    expect(convert('creatinine', si, 'umol/L', 'mg/dL')).toBeCloseTo(1.2, 10);
  });

  it('treats the canonical unit as identity', () => {
    expect(convert('creatinine', 3.4, 'mg/dL', 'mg/dL')).toBe(3.4);
  });

  it('converts temperature by formula, not factor', () => {
    expect(convert('temperature', 37, 'C', 'F')).toBeCloseTo(98.6, 10);
    expect(convert('temperature', 98.6, 'F', 'C')).toBeCloseTo(37, 10);
  });

  it('applies the enzyme U/L <-> ukat/L factor', () => {
    expect(convert('alt', 100, 'U/L', 'ukat/L')).toBeCloseTo(1.667, 10);
  });

  it('treats platelet counts in 10^9/L and 10^3/uL as numerically equivalent', () => {
    expect(convert('platelet_count', 250, '10^9/L', '10^3/uL')).toBe(250);
    expect(convert('platelet_count', 250, '10^3/uL', '10^9/L')).toBe(250);
    expect(resolveUnit('platelet_count', '10^3/µL')).toBe('10^3/uL');
  });

  it('reports known and unknown units', () => {
    expect(isKnownUnit('creatinine', 'umol/L')).toBe(true);
    expect(isKnownUnit('creatinine', 'mmol/L')).toBe(false);
    expect(isKnownUnit('nonsense', 'mg/dL')).toBe(false);
  });

  it('normalizes micro symbols, whitespace, and case without changing the advertised token', () => {
    expect(resolveUnit('creatinine', 'µmol / L')).toBe('umol/L');
    expect(resolveUnit('creatinine', 'μmol/L')).toBe('umol/L');
    expect(resolveUnit('creatinine', 'UMOL/l')).toBe('umol/L');
    expect(resolveUnit('creatinine', ' mg / dL ')).toBe('mg/dL');
    expect(resolveUnit('alt', 'µkat / l')).toBe('ukat/L');
  });

  it('round-trips every declared analyte/unit pair without material numeric drift', () => {
    for (const [analyte, definition] of Object.entries(ANALYTES)) {
      for (const unit of Object.keys(definition.units)) {
        for (const value of [0.1, 1, 37, 123.456]) {
          const converted = convert(
            analyte,
            value,
            definition.canonicalUnit,
            unit,
          );
          const restored = convert(
            analyte,
            converted,
            unit,
            definition.canonicalUnit,
          );
          expect(
            restored,
            `${analyte}: ${definition.canonicalUnit} -> ${unit} -> ${definition.canonicalUnit}`,
          ).toBeCloseTo(value, 12);
        }
      }
    }
  });

  it('throws on an unknown analyte or unit', () => {
    expect(() => convert('nonsense', 1, 'mg/dL', 'umol/L')).toThrow(/analyte/);
    expect(() => convert('creatinine', 1, 'mg/dL', 'mmol/L')).toThrow(/unit/);
  });
});
