import type { CalcSpec } from '../engine/spec-schema.js';

export type CalculatorSelection = 'candidate' | 'needs_clarification';
export type CalculatorSearchStatus = 'matched' | 'needs_clarification' | 'no_match';
export type CalculatorNoMatchReason = 'insufficient_intent' | 'not_available' | 'out_of_scope';

export interface CalculatorSearchMatch {
  id: string;
  name: string;
  model: string;
  variant?: string;
  purposeForAgents: string;
  applicability: {
    population: string;
    setting: string;
  };
  limitations: string[];
  selection: CalculatorSelection;
  matchReason: string;
}

export interface CalculatorSearchResult {
  status: CalculatorSearchStatus;
  matches: CalculatorSearchMatch[];
  noMatchReason?: CalculatorNoMatchReason;
  clarificationQuestion?: string;
}

export interface CalculatorSearchOptions {
  /** Maximum results. Values are truncated and clamped to the inclusive range 1..10. */
  limit?: number;
}

export type CalculatorSearch = (
  query: string,
  options?: CalculatorSearchOptions,
) => CalculatorSearchResult;

type IdentityKind = 'id' | 'name' | 'abbreviation' | 'synonym';

interface IdentityPhrase {
  kind: IdentityKind;
  label: string;
  normalized: string;
}

interface PopulationRoles {
  adult: boolean;
  pediatric: boolean;
  neonatal: boolean;
  donor: boolean;
  patient: boolean;
}

interface IndexedCalculator {
  spec: CalcSpec;
  identities: IdentityPhrase[];
  nameTokens: Set<string>;
  discoveryTokens: Set<string>;
  purposeTokens: Set<string>;
  populationTokens: Set<string>;
  inputTokens: Set<string>;
  exclusionOnlyTokens: Set<string>;
  variantTokens: Set<string>;
  populationRoles: PopulationRoles;
  minimumAgeYears?: number;
}

interface IdentityMatch extends IdentityPhrase {
  rank: number;
}

type ClarificationKind =
  | 'meld_model_mismatch'
  | 'timi_model_mismatch'
  | 'gfr_method_mismatch'
  | 'grace_model_mismatch'
  | 'gestational_age'
  | 'postnatal_time'
  | 'chronological_age'
  | 'family_variant'
  | 'intent_ambiguity'
  | 'method_ambiguity'
  | 'population_ambiguity'
  | 'population_conflict'
  | 'exclusion'
  | 'negation';

interface ScoredCalculator {
  entry: IndexedCalculator;
  identity?: IdentityMatch;
  score: number;
  positiveMatches: string[];
  informativeMatchCount: number;
  exclusionMatches: string[];
  clarificationKinds: ClarificationKind[];
  reasons: string[];
}

const GENERIC_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'assessment', 'assess', 'at', 'be', 'by',
  'calculate', 'calculation', 'calculator', 'clinical', 'compute', 'computed',
  'decision', 'determine', 'do', 'estimate', 'estimated', 'estimation', 'for',
  'explicit', 'from', 'give', 'help', 'i', 'in', 'interpret', 'interpretation',
  'is', 'it', 'me', 'measured', 'near', 'need', 'needed', 'needs', 'of', 'on',
  'or', 'patient', 'patients', 'please', 'preferred', 'result', 'results', 'risk',
  'score', 'scoring', 'support', 'that',
  'the', 'this', 'to', 'tool', 'use', 'used', 'using', 'value', 'values', 'want',
  'wanted', 'verify', 'when', 'with',
]);

const ROLE_ONLY_WORDS = new Set([
  'adult', 'adults', 'child', 'children', 'donor', 'gestation', 'gestational',
  'infant', 'neonate', 'neonatal', 'newborn', 'old', 'pediatric', 'paediatric',
  'patient', 'patients', 'pregnancy', 'pregnant', 'week', 'weeks', 'year', 'years',
]);

const EXCLUSION_GUARD_WORDS = new Set([
  'avoid', 'contraindicated', 'exclude', 'excluded', 'excluding', 'inaccurate',
  'invalid', 'not', 'outside', 'under', 'unreliable', 'unsupported', 'without',
]);

const SUBSCRIPT_DIGITS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
};

function canonicalToken(token: string): string {
  const aliases: Record<string, string> = {
    adults: 'adult',
    children: 'child',
    neonates: 'neonate',
    patients: 'patient',
  };
  return aliases[token] ?? token;
}

function normalizeText(text: string): string {
  return text
    .replace(/[₀-₉]/g, (digit) => SUBSCRIPT_DIGITS[digit] ?? digit)
    .replace(/\ba\s*-\s*a\b/gi, 'aa')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function exclusionGuardTokens(texts: string[]): Set<string> {
  const clauses = texts.flatMap((text) =>
    text.split(/(?:[.;!?]\s+|;\s*)/).map((clause) => clause.trim()),
  );
  const negativeClauses = clauses.filter((clause) =>
    /\b(?:not|avoid|exclude|excluded|excluding|without|under|younger|contraindicat|outside|unreliable|distorted|invalid|inaccurate|unsupported)\b/i
      .test(clause),
  );
  return baseTokens(negativeClauses.join(' '));
}

function baseTokens(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((token) => token.length >= 2 && !GENERIC_WORDS.has(token))
      .map(canonicalToken),
  );
}

function queryTokens(text: string): Set<string> {
  const normalized = normalizeText(text);
  const tokens = baseTokens(text);
  const add = (...values: string[]): void =>
    values.forEach((value) => tokens.add(canonicalToken(value)));

  if (/\b(?:pediatric|paediatric|child|children|infant|newborn|neonate|neonatal)\b/.test(normalized)) {
    add('pediatric', 'child', 'children');
  }
  if (/\b(?:adult|adults)\b/.test(normalized) || /\b18\s+(?:or\s+)?older\b/.test(normalized)) {
    add('adult');
  }
  if (/\baki\b|\bacute kidney injury\b/.test(normalized)) add('aki', 'acute', 'kidney', 'injury');
  if (/\bafib\b|\batrial fibrillation\b/.test(normalized)) add('af', 'afib', 'atrial', 'fibrillation');
  if (/\bblood gas\b|\bacid base\b/.test(normalized)) add('abg', 'blood', 'gas', 'acid', 'base');
  if (/\bbody surface area\b/.test(normalized)) add('bsa', 'body', 'surface', 'area');
  if (/\bdu bois\b/.test(normalized)) add('dubois');
  if (/\bmeld\s*na\b/.test(normalized)) add('meld');
  const mapIntent = normalized === 'map' || /\bMAP\b/.test(text) ||
    /\bmean arterial pressure\b/.test(normalized);
  if (!mapIntent) tokens.delete('map');
  if (/\bmean arterial pressure\b/.test(normalized)) add('map', 'mean', 'arterial', 'pressure');

  return tokens;
}

function noMatchResult(
  query: string,
  literalTokens: Set<string>,
  clinicalVocabulary: Set<string>,
): CalculatorSearchResult {
  if (normalizeText(query).length === 0 || literalTokens.size === 0) {
    return {
      status: 'no_match',
      matches: [],
      noMatchReason: 'insufficient_intent',
      clarificationQuestion: 'What clinical quantity, score, or named calculator should be computed?',
    };
  }

  const namesCalculatorKind =
    /\b(?:calculator|classification|criteria|equation|formula|grade|index|nomogram|rule|scale|score|staging)\b/i
      .test(query);
  const containsAcronym = query
    .split(/[^A-Za-z0-9-]+/)
    .some((token) => /^[A-Z][A-Z0-9-]{1,11}$/.test(token) && /[A-Z].*[A-Z]/.test(token));
  const clinicalOverlapCount = [...literalTokens]
    .filter((token) => clinicalVocabulary.has(token)).length;
  const hasClinicalOverlap = clinicalOverlapCount >= 2 &&
    clinicalOverlapCount / literalTokens.size >= 0.5;
  if (namesCalculatorKind || containsAcronym || hasClinicalOverlap) {
    return {
      status: 'no_match',
      matches: [],
      noMatchReason: 'not_available',
      clarificationQuestion:
        `OathMCP does not currently expose a calculator matching "${query}". ` +
        'Do not substitute another calculator. Stop, or select a supported calculator explicitly.',
    };
  }

  return {
    status: 'no_match',
    matches: [],
    noMatchReason: 'out_of_scope',
    clarificationQuestion:
      'No calculator matches this request. Rephrase with a clinical quantity or supported calculator name; ' +
      'do not substitute an unrelated calculator.',
  };
}

function phraseIsContained(query: string, phrase: string): boolean {
  return query === phrase || ` ${query} `.includes(` ${phrase} `);
}

function identityMatch(
  query: string,
  identities: IdentityPhrase[],
  rawQuery: string,
): IdentityMatch | undefined {
  const matches = identities
    .filter((identity) => {
      if (!phraseIsContained(query, identity.normalized)) return false;
      if (identity.normalized !== 'map') return true;
      return query === 'map' || /\bMAP\b/.test(rawQuery) ||
        /\bmean arterial pressure\b/.test(query);
    })
    .map((identity) => ({
      ...identity,
      rank: query === identity.normalized ? 3 : identity.normalized.includes(' ') ? 2 : 1,
    }))
    .sort((left, right) =>
      right.rank - left.rank ||
      right.normalized.length - left.normalized.length ||
      left.kind.localeCompare(right.kind) ||
      left.label.localeCompare(right.label),
    );
  return matches[0];
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

function expandNearMatches(tokens: Set<string>, vocabulary: Set<string>): Set<string> {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    // Four-character clinical abbreviations (PEEP, MELD, NIHSS prefixes, etc.)
    // are too collision-prone for one-edit fuzzy expansion.
    if (vocabulary.has(token) || token.length < 5) continue;
    for (const candidate of vocabulary) {
      if (editDistanceAtMostOne(token, candidate)) expanded.add(candidate);
    }
  }
  return expanded;
}

function rolesFor(text: string): PopulationRoles {
  const normalized = normalizeText(text).replace(/\bchild(?:\s+turcotte)?\s+pugh\b/g, ' ');
  const age = chronologicalAgeYears(normalized);
  const lexicalNeonatal = /\b(?:newborn|neonate|neonatal)\b/.test(normalized) ||
    /\binfant\b.*\bborn\b|\bborn\b.*\binfant\b/.test(normalized);
  return {
    adult: age === undefined
      ? /\badult(?:s)?\b|\b18\s+(?:years?\s+)?(?:or\s+)?older\b/.test(normalized)
      : age >= 18,
    pediatric: age === undefined
      ? /\b(?:pediatric|paediatric|child|children|infant|newborn|neonate|neonatal)\b/.test(normalized)
      : age < 18,
    neonatal: age === undefined ? lexicalNeonatal : age < 28 / 365.25,
    donor: /\bdonor(?:s)?\b/.test(normalized),
    patient: /\bpatient(?:s)?\b/.test(normalized),
  };
}

function chronologicalAgeYears(text: string): number | undefined {
  const normalized = normalizeText(text);
  const yearOld = normalized.match(
    /\b(\d{1,3}(?:\.\d+)?)\s*(days?|weeks?|months?|years?|yrs?)\s*old\b/,
  );
  if (yearOld !== null) {
    const value = Number(yearOld[1]);
    const unit = yearOld[2]!;
    if (unit.startsWith('day')) return value / 365.25;
    if (unit.startsWith('week')) return value / (365.25 / 7);
    if (unit.startsWith('month')) return value / 12;
    return value;
  }
  const compactYearOld = normalized.match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:y\s*o|yo)\b/);
  if (compactYearOld !== null) return Number(compactYearOld[1]);
  const explicitAge = normalized.match(
    /\bage(?:d)?\s+(?:of\s+)?(\d{1,3}(?:\.\d+)?)\s*(days?|weeks?|months?|years?)?\b/,
  );
  if (explicitAge === null) return undefined;
  const value = Number(explicitAge[1]);
  const unit = explicitAge[2] ?? 'years';
  if (unit.startsWith('day')) return value / 365.25;
  if (unit.startsWith('week')) return value / (365.25 / 7);
  if (unit.startsWith('month')) return value / 12;
  return value;
}

function minimumAgeYears(text: string): number | undefined {
  const normalized = normalizeText(text);
  const match = normalized.match(
    /\b(?:aged?|age)\s+(\d{1,3}(?:\.\d+)?)\s*(?:years?)?\s+(?:or|and)\s+(?:older|later)\b/,
  );
  return match === null ? undefined : Number(match[1]);
}

function declaredMinimumAgeYears(spec: CalcSpec): number | undefined {
  const ageInput = spec.inputs.age;
  if (ageInput !== undefined &&
    (ageInput.kind === 'number' || ageInput.kind === 'integer') &&
    ageInput.hardLimits !== undefined) {
    return ageInput.hardLimits[0];
  }
  return minimumAgeYears(spec.applicability.population);
}

function withoutIdentityPhrases(query: string, identities: IdentityPhrase[]): string {
  let padded = ` ${normalizeText(query)} `;
  const phrases = identities
    .map((identity) => identity.normalized)
    .filter((phrase) => phrase.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const phrase of phrases) padded = padded.replaceAll(` ${phrase} `, ' ');
  return padded.trim();
}

function populationConflict(entry: IndexedCalculator, query: PopulationRoles): boolean {
  const population = entry.populationRoles;
  return (
    (population.adult && !population.pediatric && query.pediatric) ||
    (population.pediatric && !population.adult && query.adult) ||
    (population.neonatal && query.pediatric && !query.neonatal) ||
    (population.donor && query.patient && !query.donor) ||
    (population.patient && query.donor && !query.patient)
  );
}

function hasNegation(query: string): boolean {
  const normalized = normalizeText(query);
  const applicabilityNegation =
    /\bnot\s+for\b|\b(?:avoid|exclude|excluded|never)\b|\b(?:no|not|without)\s+(?:adult|adults|child|children|pediatric|paediatric|pregnant|pregnancy|donor|patient|aki|acute)\b/;
  return applicabilityNegation.test(normalized);
}

function gestationalAgeWeeks(query: string): number | undefined {
  const withDays = query.match(
    /\b(\d{1,2})(?:\s*\+\s*([0-6]))?\s*(?:gestational\s+)?(?:weeks?|wks?|wk|w)\b/i,
  );
  if (withDays !== null) return Number(withDays[1]) + Number(withDays[2] ?? 0) / 7;
  const normalized = normalizeText(query);
  const afterGestation = normalized.match(
    /\b(?:ga|gestational age|gestation)\s*(?:of\s*)?(\d{1,2}(?:\.\d+)?)\b/,
  );
  return afterGestation === null ? undefined : Number(afterGestation[1]);
}

function postnatalAgeMinutes(query: string): number | undefined {
  const normalized = normalizeText(query);
  const timed = normalized.match(
    /\b(\d{1,4}(?:\.\d+)?)\s*(minutes?|mins?|hours?|days?|weeks?|months?|years?)\s*(?:old|after birth)\b/,
  );
  const atMinute = normalized.match(
    /\b(?:at|assessment at)\s+(\d{1,4}(?:\.\d+)?)\s*(?:minutes?|mins?)\b/,
  );
  const match = timed ?? atMinute;
  if (match === null) return undefined;
  const value = Number(match[1]);
  const unit = match[2] ?? 'minutes';
  if (unit.startsWith('hour')) return value * 60;
  if (unit.startsWith('day')) return value * 24 * 60;
  if (unit.startsWith('week')) return value * 7 * 24 * 60;
  if (unit.startsWith('month')) return value * 365.25 / 12 * 24 * 60;
  if (unit.startsWith('year')) return value * 365.25 * 24 * 60;
  return value;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 3;
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

function identityReason(identity: IdentityMatch): string {
  const qualifier = identity.rank === 3 ? 'exact' : 'matched';
  return `${qualifier} ${identity.kind} '${identity.label}'`;
}

function clarificationQuestion(
  top: ScoredCalculator,
  familyMembers: Map<string, IndexedCalculator[]>,
): string {
  const kinds = new Set(top.clarificationKinds);
  if (kinds.has('meld_model_mismatch')) {
    return 'Is the implemented MELD 3.0 model intended? OathMCP does not expose the requested MELD variant as a separate calculator.';
  }
  if (kinds.has('timi_model_mismatch')) {
    return 'The TIMI tool is the UA/NSTEMI model and excludes STEMI; should calculation stop and another model be selected?';
  }
  if (kinds.has('gfr_method_mismatch')) {
    return 'The GFR tool implements the 2021 creatinine-only CKD-EPI estimate, not measured GFR, cystatin-C eGFR, or MDRD; which method is required?';
  }
  if (kinds.has('grace_model_mismatch')) {
    return 'The GRACE tool implements the Fox 2006 admission-to-6-month mortality model, not an in-hospital GRACE variant; which model is required?';
  }
  if (kinds.has('gestational_age')) {
    return 'The EOS calculator excludes gestational age below 35 weeks; should calculation stop and another method be selected?';
  }
  if (kinds.has('postnatal_time')) {
    return 'APGAR is exposed only for assessment minutes 1, 5, 10, 15, or 20 after birth; which supported assessment time is intended?';
  }
  if (kinds.has('chronological_age')) {
    return 'The stated age falls outside the top calculator\'s declared population; should calculation stop and another method be selected?';
  }
  if (kinds.has('family_variant') && top.entry.spec.family !== undefined) {
    const variants = (familyMembers.get(top.entry.spec.family) ?? [])
      .map((entry) => `${entry.spec.id} (${entry.spec.variant ?? 'unspecified'})`)
      .sort()
      .join(' or ');
    return `Which ${top.entry.spec.family} variant is required: ${variants}?`;
  }
  if (kinds.has('population_conflict')) {
    return 'Which population and clinical role are intended? The top match conflicts with the query.';
  }
  if (kinds.has('method_ambiguity')) {
    return 'Which kidney-function method does the governing drug label or protocol require: indexed CKD-EPI eGFR, Cockcroft-Gault creatinine clearance, or a measured GFR?';
  }
  if (kinds.has('intent_ambiguity')) {
    return 'Which clinical quantity, model, and population are intended? The request does not uniquely select one calculator.';
  }
  if (kinds.has('population_ambiguity')) {
    return 'Is this an adult suspected-infection risk prompt or a neonatal early-onset sepsis estimate?';
  }
  if (kinds.has('exclusion')) {
    return 'Does the top calculator\'s stated exclusion apply? Confirm before calculation.';
  }
  return 'What should the negated population or condition be interpreted to mean before calculation?';
}

function buildIndex(specs: readonly CalcSpec[]): {
  entries: IndexedCalculator[];
  documentFrequency: Map<string, number>;
  vocabulary: Set<string>;
  familyMembers: Map<string, IndexedCalculator[]>;
} {
  const entries = specs
    .map((spec): IndexedCalculator => {
      const parentheticalSuffix = spec.name.match(/^(.*?)\s+\(([^()]*)\)$/);
      const nameVariants = [...new Set([
        spec.name,
        ...(parentheticalSuffix !== null &&
          parentheticalSuffix[2] === parentheticalSuffix[2].toUpperCase()
          ? [parentheticalSuffix[1].trim()]
          : []),
      ])];
      const identities: IdentityPhrase[] = [
        { kind: 'id' as const, label: spec.id, normalized: normalizeText(spec.id) },
        ...nameVariants.map((label) => ({
          kind: 'name' as const,
          label,
          normalized: normalizeText(label),
        })),
        ...(spec.abbreviations ?? []).map((label) => ({
          kind: 'abbreviation' as const,
          label,
          normalized: normalizeText(label),
        })),
        ...(spec.synonyms ?? []).map((label) => ({
          kind: 'synonym' as const,
          label,
          normalized: normalizeText(label),
        })),
      ].filter((identity) => identity.normalized.length > 0);
      const nameTokens = baseTokens(`${spec.id} ${spec.name} ${spec.family ?? ''} ${spec.variant ?? ''}`);
      const discoveryTokens = baseTokens([...(spec.synonyms ?? []), ...(spec.abbreviations ?? [])].join(' '));
      const purposeTokens = baseTokens(spec.purposeForAgents);
      const populationTokens = baseTokens(spec.applicability.population);
      const inputTokens = baseTokens(Object.entries(spec.inputs).map(([name, input]) => [
        name,
        input.title,
        ...(input.aliases ?? []),
        input.kind === 'quantity' ? input.quantity?.analyte ?? '' : '',
      ].join(' ')).join(' '));
      const positiveTokens = new Set([
        ...nameTokens,
        ...discoveryTokens,
        ...purposeTokens,
        ...populationTokens,
        ...inputTokens,
      ]);
      const exclusionTokens = exclusionGuardTokens([
        ...spec.applicability.exclusions,
        spec.whenNotToUse ?? '',
      ]);
      const minimumAge = declaredMinimumAgeYears(spec);
      const populationRoles = rolesFor(spec.applicability.population);
      if (minimumAge !== undefined && minimumAge < 18) {
        populationRoles.pediatric = true;
        populationRoles.adult = true;
      }
      return {
        spec,
        identities,
        nameTokens,
        discoveryTokens,
        purposeTokens,
        populationTokens,
        inputTokens,
        exclusionOnlyTokens: new Set([...exclusionTokens].filter((token) => !positiveTokens.has(token))),
        variantTokens: baseTokens(spec.variant ?? ''),
        populationRoles,
        ...(minimumAge === undefined ? {} : { minimumAgeYears: minimumAge }),
      };
    })
    .sort((left, right) => left.spec.id.localeCompare(right.spec.id));

  const documentFrequency = new Map<string, number>();
  const familyMembers = new Map<string, IndexedCalculator[]>();
  for (const entry of entries) {
    if (entry.spec.family !== undefined) {
      const members = familyMembers.get(entry.spec.family) ?? [];
      members.push(entry);
      familyMembers.set(entry.spec.family, members);
    }
    const positiveTokens = new Set([
      ...entry.nameTokens,
      ...entry.discoveryTokens,
      ...entry.purposeTokens,
      ...entry.populationTokens,
      ...entry.inputTokens,
    ]);
    for (const token of positiveTokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  // Fuzzy spelling expansion is positive-discovery-only. Expanding into an
  // exclusion token can fabricate a safety conflict (for example, neonatal →
  // neonates in a sentence that says not to use neonatal categories elsewhere).
  const vocabulary = new Set(documentFrequency.keys());
  return { entries, documentFrequency, vocabulary, familyMembers };
}

/**
 * Build a reusable, immutable calculator search function.
 *
 * Positive ranking is derived only from names, declared discovery metadata,
 * purpose, population, and inputs. Exclusion prose is indexed separately and
 * can only turn a relevant result into `needs_clarification`; it can never make
 * an otherwise unrelated calculator appear.
 */
export function createCalculatorSearch(specs: readonly CalcSpec[]): CalculatorSearch {
  const { entries, documentFrequency, vocabulary, familyMembers } = buildIndex(specs);
  const clinicalVocabulary = new Set(entries.flatMap((entry) => [
    ...entry.nameTokens,
    ...entry.discoveryTokens,
    ...entry.purposeTokens,
    ...entry.populationTokens,
    ...entry.inputTokens,
    ...entry.exclusionOnlyTokens,
  ]).filter((token) => !ROLE_ONLY_WORDS.has(token) && !EXCLUSION_GUARD_WORDS.has(token)));

  return (rawQuery, options = {}) => {
    const query = String(rawQuery ?? '').trim();
    const normalizedQuery = normalizeText(query);
    const literalTokens = baseTokens(query);
    const initialTokens = queryTokens(query);
    const expandedTokens = expandNearMatches(initialTokens, vocabulary);
    const patientAge = chronologicalAgeYears(query);
    const unmaskedQueryRole = rolesFor(query);
    const explicitSepsisCalculator = /\b(?:qsofa|eos|early onset sepsis)\b/.test(normalizedQuery);
    const genericSepsisPopulation = /\bsepsis\b/.test(normalizedQuery) &&
      !explicitSepsisCalculator &&
      !unmaskedQueryRole.adult && !unmaskedQueryRole.pediatric;
    const negated = hasNegation(query);
    const meldNa = /\bmeld\s*na\b/.test(normalizedQuery);
    const renalDosingAmbiguity = /\b(?:renal|kidney) function\b/.test(normalizedQuery) &&
      /\b(?:drug|medication|dosing|dose|label|protocol)\b/.test(normalizedQuery) &&
      !/\b(?:ckd epi|egfr|cockcroft gault|crcl|measured gfr)\b/.test(normalizedQuery);
    const ageWeeks = gestationalAgeWeeks(query);
    const postnatalMinutes = postnatalAgeMinutes(query);

    if (normalizedQuery.length === 0 || expandedTokens.size === 0) {
      return noMatchResult(query, literalTokens, clinicalVocabulary);
    }

    const scored = entries
      .map((entry): ScoredCalculator | undefined => {
        const identity = identityMatch(normalizedQuery, entry.identities, query);
        const positiveMatches = new Set<string>();
        const strongMatches = new Set<string>();
        const purposeOrInputMatches = new Set<string>();
        let score = 0;
        for (const token of expandedTokens) {
          const idf = Math.log((entries.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
          if (entry.nameTokens.has(token)) {
            score += 4 * idf;
            positiveMatches.add(token);
            strongMatches.add(token);
          }
          if (entry.discoveryTokens.has(token)) {
            score += 4 * idf;
            positiveMatches.add(token);
            strongMatches.add(token);
          }
          if (entry.purposeTokens.has(token)) {
            score += 2 * idf;
            positiveMatches.add(token);
            purposeOrInputMatches.add(token);
          }
          if (entry.populationTokens.has(token)) {
            score += 1.25 * idf;
            positiveMatches.add(token);
          }
          if (entry.inputTokens.has(token)) {
            score += idf;
            positiveMatches.add(token);
            purposeOrInputMatches.add(token);
          }
        }

        const informativeStrongMatches = [...strongMatches].filter((token) => !ROLE_ONLY_WORDS.has(token));
        const informativePurposeMatches = [...purposeOrInputMatches].filter((token) => !ROLE_ONLY_WORDS.has(token));
        const hasContextualPurposeMatch = informativePurposeMatches.length >= 1 && positiveMatches.size >= 2;
        const renalMethodCandidate = renalDosingAmbiguity &&
          (entry.spec.id === 'gfr' || entry.spec.id === 'creatinine_clearance');
        if (!renalMethodCandidate && identity === undefined && informativeStrongMatches.length === 0 &&
          informativePurposeMatches.length < 2 && !hasContextualPurposeMatch) {
          return undefined;
        }

        if (identity !== undefined) {
          // A caller explicitly naming an id/abbreviation is stronger evidence
          // than overlapping clinical prose, even when wrapped in a sentence.
          score += identity.rank === 3 ? 1_000 : identity.rank === 2 ? 500 : 250;
        }
        const exclusionMatches = [...literalTokens]
          .filter((token) => entry.exclusionOnlyTokens.has(token))
          .sort();
        const queryRole = rolesFor(withoutIdentityPhrases(query, entry.identities));
        const conflictsPopulation = populationConflict(entry, queryRole);
        if (conflictsPopulation && identity === undefined) score -= 100;
        const familyAmbiguous = entry.spec.family !== undefined &&
          (familyMembers.get(entry.spec.family)?.length ?? 0) > 1 &&
          entry.spec.variant !== undefined &&
          ![...entry.variantTokens].some((token) => expandedTokens.has(token));
        const meldModelMismatch = entry.spec.id === 'meld' &&
          (meldNa || /\bmeld\s+2(?:\s+0)?\b/.test(normalizedQuery));
        const timiModelMismatch = entry.spec.id === 'timi' &&
          (/\bstemi\b/.test(normalizedQuery) ||
            /\bst elevation (?:mi|myocardial infarction)\b/.test(normalizedQuery)) &&
          !/\b(?:nstemi|non st elevation)\b/.test(normalizedQuery);
        const gfrMethodMismatch = entry.spec.id === 'gfr' &&
          /\b(?:measured gfr|cystatin c|mdrd)\b/.test(normalizedQuery);
        const graceModelMismatch = entry.spec.id === 'grace' &&
          /\b(?:in hospital|inpatient) mortality\b/.test(normalizedQuery);
        const gestationalAgeConflict = entry.spec.id === 'eos' && ageWeeks !== undefined && ageWeeks < 35;
        const apgarTimeConflict = entry.spec.id === 'apgar' && postnatalMinutes !== undefined &&
          ![1, 5, 10, 15, 20].includes(postnatalMinutes);
        const chronologicalAgeConflict = patientAge !== undefined &&
          entry.minimumAgeYears !== undefined && patientAge < entry.minimumAgeYears;
        const gfrPregnancy = entry.spec.id === 'gfr' && /\bpregnan(?:cy|t)\b/.test(normalizedQuery);
        const ambiguousSepsisCandidate = genericSepsisPopulation &&
          (entry.spec.id === 'eos' || entry.spec.id === 'qsofa');

        const clarificationKinds: ClarificationKind[] = [];
        const reasons: string[] = [];
        if (meldModelMismatch) {
          clarificationKinds.push('meld_model_mismatch');
          reasons.push(meldNa
            ? 'query names MELD-Na, but the implemented model is MELD 3.0'
            : 'query names MELD 2.0, but the implemented model is MELD 3.0');
        }
        if (timiModelMismatch) {
          clarificationKinds.push('timi_model_mismatch');
          reasons.push('query names STEMI, but the implemented TIMI model is for UA/NSTEMI');
        }
        if (gfrMethodMismatch) {
          clarificationKinds.push('gfr_method_mismatch');
          reasons.push('query names a kidney-function method not implemented by the creatinine-only CKD-EPI tool');
        }
        if (graceModelMismatch) {
          clarificationKinds.push('grace_model_mismatch');
          reasons.push('query names in-hospital mortality, but the implemented GRACE model predicts admission-to-6-month mortality');
        }
        if (gestationalAgeConflict) {
          clarificationKinds.push('gestational_age');
          reasons.push(`gestational age ${ageWeeks} weeks is below the 35-week minimum`);
        }
        if (apgarTimeConflict) {
          clarificationKinds.push('postnatal_time');
          reasons.push(`postnatal assessment time ${postnatalMinutes} minutes is outside the supported 1/5/10/15/20-minute contract`);
        }
        if (chronologicalAgeConflict) {
          clarificationKinds.push('chronological_age');
          reasons.push(`age ${patientAge} years is below the declared minimum of ${entry.minimumAgeYears} years`);
        }
        if (familyAmbiguous) {
          clarificationKinds.push('family_variant');
          reasons.push(`variant '${entry.spec.variant}' was not specified`);
        }
        if (conflictsPopulation) {
          clarificationKinds.push('population_conflict');
          reasons.push('population or donor/patient role conflicts with the query');
        }
        if (ambiguousSepsisCandidate) {
          clarificationKinds.push('population_ambiguity');
          reasons.push('sepsis request does not distinguish adult suspected infection from neonatal early-onset sepsis');
        }
        if (renalMethodCandidate) {
          clarificationKinds.push('method_ambiguity');
          reasons.push('drug-dosing request does not specify the governing kidney-function method');
        }
        if (exclusionMatches.length > 0 || gfrPregnancy) {
          clarificationKinds.push('exclusion');
          reasons.push(gfrPregnancy
            ? 'pregnancy requires applicability confirmation for creatinine eGFR'
            : `query overlaps exclusion: ${exclusionMatches.slice(0, 4).join(', ')}`);
        }
        if (negated) {
          clarificationKinds.push('negation');
          reasons.push('query contains negation that requires confirmation');
        }

        const matchLead = identity === undefined
          ? `matched ${[...positiveMatches].sort().slice(0, 5).join(', ')}`
          : identityReason(identity);
        return {
          entry,
          identity,
          score,
          positiveMatches: [...positiveMatches].sort(),
          informativeMatchCount: [...positiveMatches]
            .filter((token) => !ROLE_ONLY_WORDS.has(token)).length,
          exclusionMatches,
          clarificationKinds,
          reasons: [matchLead, ...reasons],
        };
      })
      .filter((entry): entry is ScoredCalculator => entry !== undefined)
      .sort((left, right) =>
        Number((right.identity?.rank ?? 0) >= 2) - Number((left.identity?.rank ?? 0) >= 2) ||
        right.score - left.score ||
        (right.identity?.rank ?? 0) - (left.identity?.rank ?? 0) ||
        right.positiveMatches.length - left.positiveMatches.length ||
        left.entry.spec.id.localeCompare(right.entry.spec.id),
      );

    if (scored.length === 0) {
      return noMatchResult(query, literalTokens, clinicalVocabulary);
    }

    const topScored = scored[0];
    const topFamilyAmbiguous = topScored.clarificationKinds.includes('family_variant') &&
      topScored.entry.spec.family !== undefined;
    const vagueIntent = topScored.identity === undefined &&
      topScored.informativeMatchCount < 2 &&
      !genericSepsisPopulation && !renalDosingAmbiguity;
    const relevant = scored
      .filter((item, index) => {
        if (index === 0) return true;
        if (topFamilyAmbiguous) return item.entry.spec.family === topScored.entry.spec.family;
        if (genericSepsisPopulation &&
          (topScored.entry.spec.id === 'eos' || topScored.entry.spec.id === 'qsofa')) {
          return item.entry.spec.id === 'eos' || item.entry.spec.id === 'qsofa';
        }
        if (renalDosingAmbiguity &&
          (topScored.entry.spec.id === 'gfr' || topScored.entry.spec.id === 'creatinine_clearance')) {
          return item.entry.spec.id === 'gfr' || item.entry.spec.id === 'creatinine_clearance';
        }
        if (topScored.identity !== undefined) return item.identity !== undefined;
        if (vagueIntent) {
          return item.informativeMatchCount >= 1 &&
            !item.clarificationKinds.includes('population_conflict');
        }
        return item.score >= topScored.score * 0.6 && item.informativeMatchCount >= 2;
      });

    const explicitPopulationContext = unmaskedQueryRole.adult || unmaskedQueryRole.pediatric ||
      unmaskedQueryRole.donor || unmaskedQueryRole.patient;
    const ambiguousSemanticChoice = topScored.identity === undefined &&
      !topFamilyAmbiguous && !genericSepsisPopulation && !renalDosingAmbiguity &&
      ((vagueIntent && (!explicitPopulationContext || relevant.length > 1)) || relevant.length > 1);
    if (ambiguousSemanticChoice) {
      for (const item of relevant) {
        if (!item.clarificationKinds.includes('intent_ambiguity')) {
          item.clarificationKinds.push('intent_ambiguity');
          item.reasons.push('request does not uniquely identify a clinical quantity, model, and population');
        }
      }
    }
    const filtered = relevant.slice(0, boundedLimit(options.limit));

    const matches = filtered.map((item): CalculatorSearchMatch => ({
      id: item.entry.spec.id,
      name: item.entry.spec.name,
      model: item.entry.spec.clinicalModel.modelId,
      ...(item.entry.spec.variant === undefined ? {} : { variant: item.entry.spec.variant }),
      purposeForAgents: item.entry.spec.purposeForAgents,
      applicability: {
        population: item.entry.spec.applicability.population,
        setting: item.entry.spec.applicability.setting,
      },
      limitations: item.entry.spec.applicability.exclusions,
      selection: item.clarificationKinds.length > 0 ? 'needs_clarification' : 'candidate',
      matchReason: item.reasons.join('; '),
    }));
    const top = filtered[0];
    const status = top.clarificationKinds.length > 0 ? 'needs_clarification' : 'matched';
    return {
      status,
      matches,
      ...(status === 'needs_clarification'
        ? { clarificationQuestion: clarificationQuestion(top, familyMembers) }
        : {}),
    };
  };
}
