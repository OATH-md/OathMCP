import { describe, expect, it } from 'vitest';
import { roundHalfEven } from './round.js';

describe('roundHalfEven', () => {
  it('rounds exact decimal ties to an even final digit', () => {
    expect(roundHalfEven(2.675, 2)).toBe(2.68);
    expect(roundHalfEven(2.685, 2)).toBe(2.68);
    expect(roundHalfEven(-2.675, 2)).toBe(-2.68);
  });

  it('does not treat values merely near a tie as ties', () => {
    expect(roundHalfEven(2.5000000001)).toBe(3);
    expect(roundHalfEven(2.4999999999)).toBe(2);
  });
});
