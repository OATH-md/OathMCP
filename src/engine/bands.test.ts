import { describe, it, expect } from 'vitest';
import { evaluateBands } from './bands.js';
import type { Band } from './spec-schema.js';

const band = (when: string): Band => ({
  code: `test_${when.replace(/\W/g, '_')}`,
  kind: 'status',
  when,
  label: when,
  severity: 'normal',
  evidenceRefs: ['test_source'],
});

describe('band expression grammar', () => {
  it('matches >=N', () => {
    expect(evaluateBands([band('>=90')], 90)?.when).toBe('>=90');
    expect(evaluateBands([band('>=90')], 89.9)).toBeNull();
  });

  it('matches <=N', () => {
    expect(evaluateBands([band('<=10')], 10)?.when).toBe('<=10');
    expect(evaluateBands([band('<=10')], 10.1)).toBeNull();
  });

  it('matches >N (strict)', () => {
    expect(evaluateBands([band('>5')], 5.1)?.when).toBe('>5');
    expect(evaluateBands([band('>5')], 5)).toBeNull();
  });

  it('matches <N (strict)', () => {
    expect(evaluateBands([band('<15')], 14.9)?.when).toBe('<15');
    expect(evaluateBands([band('<15')], 15)).toBeNull();
  });

  it('matches an inclusive range N-M', () => {
    const bands = [band('30-59')];
    expect(evaluateBands(bands, 30)?.when).toBe('30-59');
    expect(evaluateBands(bands, 59)?.when).toBe('30-59');
    expect(evaluateBands(bands, 29.9)).toBeNull();
    expect(evaluateBands(bands, 59.1)).toBeNull();
  });

  it('matches ==value for numbers and strings', () => {
    expect(evaluateBands([band('==0')], 0)?.when).toBe('==0');
    expect(evaluateBands([band('==male')], 'male')?.when).toBe('==male');
    expect(evaluateBands([band('==male')], 'female')).toBeNull();
  });

  it('returns the first matching band in order', () => {
    const bands = [band('>=90'), band('60-89'), band('<60')];
    const bands2 = [
      { ...band('>=90'), label: 'high' },
      { ...band('60-89'), label: 'mid', severity: 'borderline' as const },
    ];
    expect(evaluateBands(bands, 95)?.when).toBe('>=90');
    expect(evaluateBands(bands2, 75)?.label).toBe('mid');
  });

  it('throws on a malformed expression', () => {
    expect(() => evaluateBands([band('between 1 and 2')], 1)).toThrow(
      /Unrecognized band expression/,
    );
  });
});
