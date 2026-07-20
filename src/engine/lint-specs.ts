/**
 * Assert that the declarative spec catalog and executable compute catalog are
 * an exact pair. This catches both advertised-but-unrunnable calculators and
 * dead compute modules that are no longer represented by a spec.
 */
export function assertComputeCoverage(
  specIds: Iterable<string>,
  computeIds: Iterable<string>,
): void {
  const specs = new Set(specIds);
  const computes = new Set(computeIds);
  const missing = [...specs].filter((id) => !computes.has(id)).sort();
  const orphaned = [...computes].filter((id) => !specs.has(id)).sort();

  const issues: string[] = [];
  if (missing.length > 0) {
    issues.push(`missing compute functions: ${missing.join(', ')}`);
  }
  if (orphaned.length > 0) {
    issues.push(`compute functions without specs: ${orphaned.join(', ')}`);
  }
  if (issues.length > 0) {
    throw new Error(`Spec catalog validation failed — ${issues.join('; ')}`);
  }
}

function inputSignature(input: {
  conceptId: string;
  kind: string;
  enumValues?: Array<{ value: string }>;
  quantity?: { canonicalUnit: string };
}): string {
  const domain = input.kind === 'enum'
    ? `:${(input.enumValues ?? []).map((entry) => entry.value).sort().join('|')}`
    : '';
  const unit = input.kind === 'quantity'
    ? `:${input.quantity?.canonicalUnit ?? '(missing unit)'}`
    : '';
  return `${input.conceptId}:${input.kind}${domain}${unit}`;
}

/** Shared panel inputs are opt-in and must represent the exact same concept. */
export function assertSharedInputCompatibility(
  specs: Iterable<{
    id: string;
    inputs: Record<string, {
      conceptId: string;
      sharedKey?: string;
      kind: string;
      enumValues?: Array<{ value: string }>;
      quantity?: { canonicalUnit: string };
    }>;
  }>,
): void {
  const signatures = new Map<string, Map<string, string[]>>();
  for (const spec of specs) {
    for (const input of Object.values(spec.inputs)) {
      if (input.sharedKey === undefined) continue;
      const signature = inputSignature(input);
      const bySignature = signatures.get(input.sharedKey) ?? new Map<string, string[]>();
      bySignature.set(signature, [...(bySignature.get(signature) ?? []), spec.id]);
      signatures.set(input.sharedKey, bySignature);
    }
  }

  const conflicts = [...signatures.entries()]
    .filter(([, variants]) => variants.size > 1)
    .map(([name, variants]) =>
      `${name}: ${[...variants.entries()]
        .map(([signature, ids]) => `${signature} (${ids.join(', ')})`)
        .join(' vs ')}`,
    );
  if (conflicts.length > 0) {
    throw new Error(`Shared input compatibility failed — ${conflicts.join('; ')}`);
  }
}

const REPLACED_INPUT_NAMES: Readonly<Record<string, string>> = {
  gender: 'sex',
  weight: 'weight_kg',
  height: 'height_cm',
  systolic: 'systolic_bp',
  diastolic: 'diastolic_bp',
  Na: 'sodium',
  Cl: 'chloride',
  HCO3: 'bicarbonate',
  pH: 'ph',
  PaCO2: 'paco2',
  PaO2: 'pao2',
  FiO2: 'fio2',
};

const CANONICAL_TOKEN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const NUMERIC_ENUM_TOKEN = /^\d+(?:\.\d+)?$/;
const BOOLEAN_PREFIX = /^(?:is|has)_/;

/**
 * Titles are display labels, not a second unit declaration. Keep this detector
 * deliberately conservative: only a parenthetical made entirely from a known
 * measurement unit/rate token is rejected, while semantic qualifiers such as
 * `(Skin Color)`, `(ABC/2)`, or `(Scaled)` remain valid.
 */
const UNIT_TITLE_PARENTHETICALS = new Set([
  '%',
  'per1000',
  'year',
  'years',
  'week',
  'weeks',
  'day',
  'days',
  'hour',
  'hours',
  'kg',
  'g',
  'mg',
  'ug',
  'mcg',
  'l',
  'ml',
  'dl',
  'cm',
  'mm',
  'm',
  'm2',
  'cm3',
  'mm3',
  'mmhg',
  'cmh2o',
  'meq',
  'meq/l',
  'mmol/l',
  'mg/dl',
  'g/dl',
  'iu/l',
  'u/l',
  'ul',
  'ml/min',
  'ml/min/1.73m2',
  'mg/kg/min',
  'beats/min',
  'breaths/min',
  'bpm',
  '°c',
  '°f',
]);

function titleHasUnitParenthetical(title: string): boolean {
  for (const match of title.matchAll(/\(([^()]*)\)/g)) {
    const normalized = match[1]
      .normalize('NFKC')
      .replace(/[µμ]/g, 'u')
      .replace(/\s+/g, '')
      .toLowerCase();
    if (UNIT_TITLE_PARENTHETICALS.has(normalized)) return true;
  }
  return false;
}

/** Enforce stable MCP-facing identifiers while permitting compatibility aliases. */
export function assertNamingConventions(
  specs: Iterable<{
    id: string;
    inputs: Record<
      string,
      { title: string; kind: string; enumValues?: Array<{ value: string }> }
    >;
    outputs: Record<string, { title: string }>;
  }>,
): void {
  const issues: string[] = [];
  for (const spec of specs) {
    if (!CANONICAL_TOKEN.test(spec.id)) {
      issues.push(`${spec.id}: calculator ids must use lowercase snake_case`);
    }

    for (const [name, input] of Object.entries(spec.inputs)) {
      const replacement = REPLACED_INPUT_NAMES[name];
      if (replacement !== undefined) {
        issues.push(`${spec.id}.${name}: use '${replacement}'`);
      } else if (!CANONICAL_TOKEN.test(name)) {
        issues.push(`${spec.id}.${name}: input ids must use lowercase snake_case`);
      }

      if (input.kind === 'boolean' && BOOLEAN_PREFIX.test(name)) {
        issues.push(
          `${spec.id}.${name}: boolean ids must use a positive-condition noun without an is_/has_ prefix`,
        );
      }
      if (titleHasUnitParenthetical(input.title)) {
        issues.push(
          `${spec.id}.${name}: input titles must not repeat measurement units in parentheses`,
        );
      }

      for (const option of input.enumValues ?? []) {
        if (
          !CANONICAL_TOKEN.test(option.value) &&
          !NUMERIC_ENUM_TOKEN.test(option.value)
        ) {
          issues.push(
            `${spec.id}.${name}='${option.value}': enum values must use lowercase snake_case`,
          );
        }
      }
    }

    for (const [name, output] of Object.entries(spec.outputs)) {
      if (!CANONICAL_TOKEN.test(name)) {
        issues.push(`${spec.id}.${name}: output ids must use lowercase snake_case`);
      }
      if (titleHasUnitParenthetical(output.title)) {
        issues.push(
          `${spec.id}.${name}: output titles must not repeat measurement units in parentheses`,
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`Spec naming validation failed — ${issues.join('; ')}`);
  }
}
