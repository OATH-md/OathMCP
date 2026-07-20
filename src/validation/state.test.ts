import { describe, expect, it } from 'vitest';
import { LiteratureSearchRecordSchema, ValidationDossierSchema, type CaseExecutionResult } from './schema.js';
import { deriveGroupReadiness, deriveReviewState, deriveReviewStateWithIssues } from './state.js';

const search = LiteratureSearchRecordSchema.parse({
  id: 'search:state', calculatorId: 'bmi', model: 'BMI', variant: 'adult', searchedAt: '2026-07-15', reviewBy: '2027-07-15',
  sources: [{ id: 'source:medline', sourceRole: 'bibliographic_database', authorityId: 'pubmed_medline', database: 'MEDLINE', site: 'PubMed', interface: 'web', exactQuery: 'BMI', translationExposed: false, filters: [], coverageTo: '2026-07-15', searchedAt: '2026-07-15', reviewer: 'one', recordsRetrieved: 1, stableCitationIds: ['PMID:1'] }],
  accounting: { retrieved: 1, deduplicated: 1, screened: 1, fullTextAssessed: 1, excluded: 0, included: 1 },
  deduplication: { method: 'PMID', tool: 'manual', version: '1' },
  screenedCitations: [{ citationId: 'source:one', title: 'Source', disposition: 'included', fullTextAssessed: true }],
  citationChasing: { backward: true, forward: true }, checks: { corrections: true, retractions: true, supersession: true },
  qualityReview: { method: 'PRESS-derived', initialMedlineSourceId: 'source:medline', checklist: ['terms'], comments: [], resolution: 'accepted', resolved: true, reviewer: 'two', reviewedAt: '2026-07-15' },
});
function dossier(overrides: Record<string, unknown> = {}) {
  return ValidationDossierSchema.parse({
    calculatorId: 'bmi', specVersion: '1.0.0', clinicalModel: 'BMI', variant: 'adult', population: 'adults', setting: 'screening', assessmentTiming: 'current', endpoint: 'BMI category', reviewGroup: 'formula_unit_dosing', enrollment: 'pending_independent_review', searchRecords: [], authoritySourceIds: [], claims: [], cases: [], explicitBlockers: [],
    ...overrides,
  });
}

const supportedClaim = {
  id: 'claim:bmi', kind: 'formula' as const, statement: 'BMI formula', status: 'supported' as const,
  covers: ['formula:implementation'],
  sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'equation 1' }],
  executable: false, scenarioIds: [], nonExecutableRationale: 'source-only demonstration', reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
};

describe('derived review state', () => {
  it('derives group readiness only from complete member reports', () => {
    const member = (calculatorId: string, state: 'source_verified' | 'scenario_verified' | 'blocked') => ({
      calculatorId,
      issues: [],
      reviewState: {
        state,
        derivedAt: '2026-07-17T00:00:00.000Z', blockers: [], staleSourceIds: [],
        counts: { claimsTotal: 1, claimsSupported: 1, requiredCases: 3, passedCases: 3, executableClaims: 1, witnessedExecutableClaims: 1 },
      },
    });
    expect(deriveGroupReadiness('formula_unit_dosing', ['a', 'b'], [
      member('a', 'scenario_verified'), member('b', 'scenario_verified'),
    ]).state).toBe('scenario_verified');
    expect(deriveGroupReadiness('formula_unit_dosing', ['a', 'b'], [
      member('a', 'scenario_verified'), member('b', 'source_verified'),
    ]).state).toBe('source_verified');
    expect(deriveGroupReadiness('formula_unit_dosing', ['a', 'b'], [
      member('a', 'scenario_verified'),
    ])).toMatchObject({ state: 'pending', missingCalculatorIds: ['b'] });
    expect(deriveGroupReadiness('formula_unit_dosing', ['a', 'b'], [
      member('a', 'scenario_verified'), member('b', 'blocked'),
    ]).state).toBe('blocked');
  });
  it('uses deterministic pending, search, source, scenario, stale, and blocked precedence', () => {
    const now = new Date('2026-07-15T12:00:00Z');
    expect(deriveReviewState(dossier(), new Map(), now).state).toBe('pending');
    expect(deriveReviewStateWithIssues(dossier({ searchRecords: [search] }), new Map(), now, []).state).toBe('search_complete');
    expect(deriveReviewStateWithIssues(dossier({ searchRecords: [search], claims: [supportedClaim] }), new Map(), now, []).state).toBe('source_verified');

    const referenceCases = Array.from({ length: 3 }, (_, index) => ({
      kind: 'reference' as const, id: `case:bmi:${index + 1}`, tags: ['calculator:bmi:core'],
      inputs: { weight_kg: 70 + index, height_cm: 170 }, expected: { bmi: 24.22 + index },
      expectedBehavior: 'calculate' as const,
      tolerance: { mode: 'absolute' as const, value: 0.01, rationale: 'published precision' },
      claimIds: ['claim:bmi'], sourceIds: ['source:one'], witnesses: ['formula:implementation'],
    }));
    const executable = {
      ...supportedClaim,
      executable: true,
      scenarioIds: referenceCases.map((testCase) => testCase.id),
      nonExecutableRationale: undefined,
    };
    const passed = (caseId: string): CaseExecutionResult => ({
      caseId, status: 'passed', enginePassed: true, fullMcpPassed: true,
      compactMcpPassed: true, parityPassed: true, issues: [],
    });
    const scenario = dossier({ searchRecords: [search], claims: [executable], cases: referenceCases });
    const passedResults = new Map(referenceCases.map((testCase) => [testCase.id, passed(testCase.id)]));
    expect(deriveReviewStateWithIssues(scenario, passedResults, now, []).state).toBe('scenario_verified');
    expect(deriveReviewStateWithIssues(
      scenario, passedResults, new Date('2027-07-15T23:59:59.999Z'), [],
    ).state).toBe('scenario_verified');
    expect(deriveReviewStateWithIssues(
      scenario, passedResults, new Date('2027-07-16T00:00:00.000Z'), [],
    ).state).toBe('stale');

    const duplicatedReferences = referenceCases.map((testCase, index) => ({
      ...testCase,
      inputs: referenceCases[0]!.inputs,
      expected: referenceCases[0]!.expected,
      sourceIds: [`source:renamed:${index + 1}`],
      tolerance: { mode: 'absolute' as const, value: 0.01 + index, rationale: `renamed tolerance ${index + 1}` },
      omittedOutputs: [`irrelevant_output_${index + 1}`],
      expectedError: { code: 'BAD_TYPE' as const, field: `irrelevant_${index + 1}` },
    }));
    const duplicatedScenario = dossier({
      searchRecords: [search], claims: [executable], cases: duplicatedReferences,
    });
    expect(deriveReviewStateWithIssues(duplicatedScenario, passedResults, now, []).state)
      .toBe('source_verified');

    for (const count of [1, 2]) {
      const cases = referenceCases.slice(0, count);
      const partialClaim = { ...executable, scenarioIds: cases.map((testCase) => testCase.id) };
      const partial = dossier({ searchRecords: [search], claims: [partialClaim], cases });
      const results = new Map(cases.map((testCase) => [testCase.id, passed(testCase.id)]));
      expect(deriveReviewStateWithIssues(partial, results, now, []).state, `${count} references`).toBe('source_verified');
    }

    const staleSearch = { ...search, searchedAt: '2025-01-01', reviewBy: '2026-01-01' };
    expect(deriveReviewStateWithIssues(dossier({ searchRecords: [staleSearch], claims: [supportedClaim] }), new Map(), now, []).state).toBe('stale');
    const staleClaim = { ...supportedClaim, reviewedAt: '2025-01-01', reviewBy: '2026-01-01' };
    expect(deriveReviewStateWithIssues(dossier({ searchRecords: [search], claims: [staleClaim] }), new Map(), now, []).state).toBe('stale');
    const blocked = dossier({ explicitBlockers: [{ code: 'manual:block', message: 'unresolved conflict', severity: 'error' }] });
    expect(deriveReviewState(blocked, new Map(), now).state).toBe('blocked');
    const failedWithoutIssues: CaseExecutionResult = {
      caseId: referenceCases[0]!.id, status: 'passed', enginePassed: true,
      fullMcpPassed: true, compactMcpPassed: false, parityPassed: false, issues: [],
    };
    const oneFailed = new Map(passedResults);
    oneFailed.set(failedWithoutIssues.caseId, failedWithoutIssues);
    expect(deriveReviewStateWithIssues(scenario, oneFailed, now, []).state).toBe('blocked');

    const passedWithIssues = new Map(passedResults);
    passedWithIssues.set(referenceCases[0]!.id, {
      ...passed(referenceCases[0]!.id),
      issues: [{ code: 'case.hidden_issue', message: 'must not be ignored', severity: 'error' }],
    });
    expect(deriveReviewStateWithIssues(scenario, passedWithIssues, now, []).state).toBe('blocked');

    const substituted = new Map([...passedResults].slice(0, 2));
    substituted.set('case:unknown', passed('case:unknown'));
    expect(deriveReviewStateWithIssues(scenario, substituted, now, []).state).toBe('blocked');

    const mismatchedIdentity = new Map(passedResults);
    mismatchedIdentity.set(referenceCases[2]!.id, passed('case:wrong-identity'));
    expect(deriveReviewStateWithIssues(scenario, mismatchedIdentity, now, []).state).toBe('blocked');

    const staleScenario = dossier({
      searchRecords: [{ ...search, searchedAt: '2025-01-01', reviewBy: '2026-01-01' }],
      claims: [executable], cases: referenceCases,
    });
    expect(deriveReviewStateWithIssues(staleScenario, passedResults, now, []).state).toBe('stale');
    const blockedAndStale = dossier({
      searchRecords: [{ ...search, searchedAt: '2025-01-01', reviewBy: '2026-01-01' }],
      claims: [executable], cases: referenceCases,
      explicitBlockers: [{ code: 'manual:block', message: 'unresolved conflict', severity: 'error' }],
    });
    expect(deriveReviewStateWithIssues(blockedAndStale, passedResults, now, []).state).toBe('blocked');
  });

  it('does not infer verification without claims and executed source-derived cases', () => {
    const state = deriveReviewState(dossier(), new Map(), new Date('2026-07-15T12:00:00Z'));
    expect(state.state).toBe('pending');
    expect(state.counts.claimsSupported).toBe(0);
  });

  it('keeps compatibility approvals outside clinical assurance counts and gates', () => {
    const compatibilityClaim = {
      id: 'claim:bmi:compatibility',
      scope: 'compatibility' as const,
      kind: 'input' as const,
      statement: 'Removing an ambiguous BMI alias is an approved compatibility break.',
      status: 'supported' as const,
      covers: ['compatibility:safeAliases:bmi.weight_kg'],
      sourceIds: [],
      locators: [],
      executable: false,
      scenarioIds: [],
      nonExecutableRationale: 'Compatibility approval; no clinical source applies.',
      compatibilityDecision: {
        oldBehavior: 'Generic weight alias was accepted.',
        replacement: 'The generic alias is rejected.',
        rationale: 'Removing an ambiguous BMI alias is an approved compatibility break.',
      },
      reviewedAt: '2026-07-15',
      reviewBy: '2026-01-01',
    };
    const state = deriveReviewStateWithIssues(
      dossier({ searchRecords: [search], claims: [supportedClaim, compatibilityClaim] }),
      new Map(),
      new Date('2026-07-15T12:00:00Z'),
      [],
    );

    expect(state.state).toBe('source_verified');
    expect(state.staleSourceIds).toEqual([]);
    expect(state.counts.claimsTotal).toBe(1);
    expect(state.counts.claimsSupported).toBe(1);
  });

  it('does not let the public derivation bypass source-bundle and coverage integrity', () => {
    const state = deriveReviewState(
      dossier({ searchRecords: [search], claims: [supportedClaim] }),
      new Map(),
      new Date('2026-07-15T12:00:00Z'),
    );
    expect(state.state).toBe('blocked');
    expect(state.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'search.source_role', 'claim.missing_coverage',
    ]));
  });
});
