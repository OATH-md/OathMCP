/** Closed analyte unit-conversion table shared by every calculator. */

interface UnitConversion {
  toCanonical: (v: number) => number;
  fromCanonical: (v: number) => number;
}

interface AnalyteSpec {
  canonicalUnit: string;
  units: Record<string, UnitConversion>;
}

/**
 * Build the two conversion functions for a non-canonical unit from a single
 * `SI = US × factor` factor. The canonical (US) unit is registered separately
 * as an identity conversion by `defineAnalyte`.
 */
function factor(f: number): UnitConversion {
  return {
    toCanonical: (v) => v / f,
    fromCanonical: (v) => v * f,
  };
}

const IDENTITY: UnitConversion = {
  toCanonical: (v) => v,
  fromCanonical: (v) => v,
};

/**
 * Define an analyte whose canonical unit is a simple factor base. The canonical
 * unit maps to identity; each additional `[unit, factor]` entry uses `SI = US × factor`.
 */
function defineAnalyte(
  canonicalUnit: string,
  others: Record<string, number>,
): AnalyteSpec {
  const units: Record<string, UnitConversion> = { [canonicalUnit]: IDENTITY };
  for (const [unit, f] of Object.entries(others)) {
    units[unit] = factor(f);
  }
  return { canonicalUnit, units };
}

export const ANALYTES: Record<string, AnalyteSpec> = {
  creatinine: defineAnalyte('mg/dL', { 'umol/L': 88.4 }),
  bilirubin: defineAnalyte('mg/dL', { 'umol/L': 17.1 }),
  calcium: defineAnalyte('mg/dL', { 'mmol/L': 0.2495 }),
  albumin: defineAnalyte('g/dL', { 'g/L': 10 }),
  glucose: defineAnalyte('mg/dL', { 'mmol/L': 0.05551 }),
  bun: defineAnalyte('mg/dL', { 'mmol/L': 0.357 }),
  wbc: defineAnalyte('cells/mm3', { '10^9/L': 0.001 }),
  platelet_count: defineAnalyte('10^9/L', { '10^3/uL': 1.0 }),
  hematocrit: defineAnalyte('percent', { 'L/L': 0.01 }),
  pao2: defineAnalyte('mmHg', { kPa: 0.133322 }),
  base_deficit: defineAnalyte('mEq/L', { 'mmol/L': 1.0 }),
  fluid_volume: defineAnalyte('L', { mL: 1000 }),
  // Sodium: US and SI are the same units (factor 1.0) but both names are accepted.
  sodium: defineAnalyte('mEq/L', { 'mmol/L': 1.0 }),

  cholesterol: defineAnalyte('mg/dL', { 'mmol/L': 0.02586 }),
  magnesium: defineAnalyte('mg/dL', { 'mmol/L': 0.4114 }),
  phosphate: defineAnalyte('mg/dL', { 'mmol/L': 0.323 }),
  hemoglobin: defineAnalyte('g/dL', { 'mmol/L': 0.6206 }),
  testosterone: defineAnalyte('ng/dL', { 'nmol/L': 0.03467 }),
  ammonia: defineAnalyte('ug/dL', { 'umol/L': 0.5872 }),
  total_protein: defineAnalyte('g/dL', { 'g/L': 10 }),

  // Enzyme group: U/L ↔ µkat/L, factor 0.01667
  amylase: defineAnalyte('U/L', { 'ukat/L': 0.01667 }),
  ldh: defineAnalyte('U/L', { 'ukat/L': 0.01667 }),
  alt: defineAnalyte('U/L', { 'ukat/L': 0.01667 }),
  ast: defineAnalyte('U/L', { 'ukat/L': 0.01667 }),
  alp: defineAnalyte('U/L', { 'ukat/L': 0.01667 }),
  ggt: defineAnalyte('U/L', { 'ukat/L': 0.01667 }),

  // Temperature is a formula, not a factor (canonical = Celsius).
  temperature: {
    canonicalUnit: 'C',
    units: {
      C: IDENTITY,
      F: {
        toCanonical: (v) => ((v - 32) * 5) / 9,
        fromCanonical: (v) => (v * 9) / 5 + 32,
      },
    },
  },
};

export function isKnownUnit(analyte: string, unit: string): boolean {
  return resolveUnit(analyte, unit) !== undefined;
}

function unitKey(unit: string): string {
  return unit
    .normalize('NFKC')
    .replace(/[µμ]/g, 'u')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Resolve spelling variants to the catalog's advertised unit token. */
export function resolveUnit(analyte: string, unit: string): string | undefined {
  const spec = ANALYTES[analyte];
  if (spec === undefined) return undefined;
  const requested = unitKey(unit);
  return Object.keys(spec.units).find((candidate) => unitKey(candidate) === requested);
}

/**
 * Convert `value` of `analyte` from `fromUnit` to `toUnit`. Routes through the
 * canonical (US) unit. Throws if the analyte or either unit is unknown.
 */
export function convert(
  analyte: string,
  value: number,
  fromUnit: string,
  toUnit: string,
): number {
  const spec = ANALYTES[analyte];
  if (spec === undefined) {
    throw new Error(`Unknown analyte '${analyte}'`);
  }
  const resolvedFrom = resolveUnit(analyte, fromUnit);
  const from = resolvedFrom === undefined ? undefined : spec.units[resolvedFrom];
  if (from === undefined) {
    throw new Error(`Unknown unit '${fromUnit}' for analyte '${analyte}'`);
  }
  const resolvedTo = resolveUnit(analyte, toUnit);
  const to = resolvedTo === undefined ? undefined : spec.units[resolvedTo];
  if (to === undefined) {
    throw new Error(`Unknown unit '${toUnit}' for analyte '${analyte}'`);
  }
  return to.fromCanonical(from.toCanonical(value));
}
