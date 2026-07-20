/**
 * Interpretation-band matcher.
 *
 * Evaluates a spec's `interpretationBands[].when` expression against a computed
 * value. The `when` grammar is a CLOSED set of fixed forms — there is NO general
 * expression evaluator, no `eval`, no `new Function`:
 *
 *   '>=N'   value >= N
 *   '<=N'   value <= N
 *   '>N'    value > N
 *   '<N'    value < N
 *   'N-M'   N <= value <= M   (inclusive range; N and M numeric)
 *   '==X'   value === X       (X compared as number when numeric, else as string)
 *
 * Anything else throws — a malformed band is an authoring bug, not a silent miss.
 */
import type { Band } from './spec-schema.js';

interface ParsedWhen {
  predicate: (value: number | string) => boolean;
  domain: 'numeric' | 'string';
  boundaries: number[];
}

const NUM = String.raw`-?\d+(?:\.\d+)?`;

// Ordered alternation: '>=' / '<=' must precede '>' / '<' so the two-char
// comparators win the match.
const OPS: Record<string, (a: number, b: number) => boolean> = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
};

const CMP_RE = new RegExp(`^(>=|<=|>|<)(${NUM})$`);
const RANGE_RE = new RegExp(`^(${NUM})-(${NUM})$`);

function parseWhen(when: string): ParsedWhen {
  const expr = when.trim();

  const cmp = CMP_RE.exec(expr);
  if (cmp) {
    const op = OPS[cmp[1]];
    const n = Number(cmp[2]);
    return {
      predicate: (v) => op(Number(v), n),
      domain: 'numeric',
      boundaries: [n],
    };
  }

  const range = RANGE_RE.exec(expr);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return {
      predicate: (v) => {
        const n = Number(v);
        return n >= lo && n <= hi;
      },
      domain: 'numeric',
      boundaries: [lo, hi],
    };
  }

  if (expr.startsWith('==')) {
    const target = expr.slice(2);
    const targetNum = Number(target);
    const targetIsNumeric = target !== '' && !Number.isNaN(targetNum);
    return {
      predicate: (v) => {
        if (targetIsNumeric && typeof v === 'number') {
          return v === targetNum;
        }
        return String(v) === target;
      },
      domain: targetIsNumeric ? 'numeric' : 'string',
      boundaries: targetIsNumeric ? [targetNum] : [],
    };
  }

  throw new Error(`Unrecognized band expression: '${when}'`);
}

/**
 * Return the first band whose `when` matches `value`, or null if none match.
 */
export function evaluateBands(
  bands: Band[],
  value: number | string,
  context: Record<string, number | string | boolean> = {},
): Band | null {
  for (const band of bands) {
    const segmentMatches = (band.where ?? []).every(({ field, when }) => {
      const segmentValue = context[field];
      return segmentValue !== undefined && matchesWhen(when, segmentValue);
    });
    if (segmentMatches && parseWhen(band.when).predicate(value)) {
      return band;
    }
  }
  return null;
}

/**
 * Evaluate a single `when` expression (same closed grammar as bands) against a
 * value. Used by the runner for cap/clamp warning rules. Booleans are compared
 * as their string form, so `==true` matches a boolean `true`.
 */
export function matchesWhen(
  when: string,
  value: number | string | boolean,
): boolean {
  return parseWhen(when).predicate(
    typeof value === 'boolean' ? String(value) : value,
  );
}

/** Numeric thresholds used by a `when` expression, or null for string equality. */
export function numericWhenBoundaries(when: string): number[] | null {
  const parsed = parseWhen(when);
  return parsed.domain === 'numeric' ? parsed.boundaries : null;
}

/**
 * Return a representative numeric value not covered by any band, or null when
 * the numeric domain is total. String-equality bands are valid but cannot be
 * proven total without an output enum, so callers should skip totality for
 * those sets.
 */
export function findUncoveredNumericBandValue(
  bands: Band[],
  context?: Record<string, number | string | boolean>,
): number | null {
  if (bands.length === 0) {
    throw new Error('at least one interpretation band is required');
  }
  const parsed = bands.map((band) => parseWhen(band.when));
  // A context is required to prove one slice of a segmented band set. The spec
  // loader enumerates representative contexts for every segmenting input.
  if (bands.some((band) => band.where !== undefined) && context === undefined) {
    return null;
  }
  const domains = new Set(parsed.map((entry) => entry.domain));
  if (domains.size > 1) {
    throw new Error('cannot mix numeric and string band expressions');
  }
  if (domains.has('string')) return null;

  const ordered = [...new Set(parsed.flatMap((entry) => entry.boundaries))].sort(
    (a, b) => a - b,
  );

  const probes = new Set<number>([Number.NEGATIVE_INFINITY, ...ordered]);
  for (let index = 1; index < ordered.length; index += 1) {
    probes.add((ordered[index - 1] + ordered[index]) / 2);
  }
  probes.add(Number.POSITIVE_INFINITY);

  for (const probe of probes) {
    if (evaluateBands(bands, probe, context) === null) return probe;
  }
  return null;
}
