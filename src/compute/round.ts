/** Shared decimal round-half-to-even helper for calculator outputs. */

/**
 * Round `x` to `dp` decimal places using decimal half-to-even. Decimal exponent
 * shifting avoids the fixed tie epsilon that can misclassify near-tie values.
 */
export function roundHalfEven(x: number, dp = 0): number {
  if (!Number.isFinite(x)) return x;
  if (!Number.isInteger(dp) || dp < 0 || dp > 15) {
    throw new RangeError('decimal places must be an integer from 0 through 15');
  }

  const shift = (value: number, places: number): number => {
    const [coefficient, exponent = '0'] = value.toString().split('e');
    return Number(`${coefficient}e${Number(exponent) + places}`);
  };

  const shifted = shift(x, dp);
  const sign = shifted < 0 ? -1 : 1;
  const magnitude = Math.abs(shifted);
  const lower = Math.floor(magnitude);
  const fraction = magnitude - lower;
  const roundedMagnitude =
    fraction < 0.5
      ? lower
      : fraction > 0.5
        ? lower + 1
        : lower % 2 === 0
          ? lower
          : lower + 1;
  return shift(sign * roundedMagnitude, -dp);
}
