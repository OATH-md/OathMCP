import { describe, expect, it } from 'vitest';
import {
  ClinicalClaimSchema,
  CompatibilityClaimLinkSchema,
  LiteratureSearchRecordSchema,
  ValidationCaseSchema,
  ValidationDossierSchema,
} from './schema.js';

describe('clinical validation schemas', () => {
  it('rejects unknown authoring keys at every protected boundary', () => {
    expect(() => ValidationDossierSchema.parse({ unknown: true })).toThrow();
    expect(() => ValidationCaseSchema.parse({
      kind: 'reference', id: 'case:one', tags: ['required-inputs'], inputs: {}, expected: {},
      expectedBehavior: 'calculate', tolerance: { mode: 'exact', rationale: 'literal' },
      claimIds: ['claim:one'], sourceIds: ['source:one'], passed: true,
    })).toThrow(/unrecognized/i);
  });

  it('allows translated queries only when the search interface exposes one', () => {
    const record = {
      id: 'search:one', calculatorId: 'bmi', model: 'BMI', variant: 'adult',
      searchedAt: '2026-07-15', reviewBy: '2027-07-15',
      sources: [{
        id: 'search:pubmed', database: 'MEDLINE', site: 'PubMed', interface: 'web',
        sourceRole: 'bibliographic_database', authorityId: 'pubmed_medline',
        exactQuery: 'body mass index', translationExposed: false, translatedQuery: 'BMI', filters: [],
        coverageTo: '2026-07-15', searchedAt: '2026-07-15', reviewer: 'reviewer',
        recordsRetrieved: 1, stableCitationIds: ['PMID:1'],
      }],
      accounting: { retrieved: 1, deduplicated: 1, screened: 1, fullTextAssessed: 1, excluded: 0, included: 1 },
      deduplication: { method: 'exact ID', tool: 'manual', version: '1' },
      screenedCitations: [{ citationId: 'pmid:1', title: 'Study', disposition: 'included', fullTextAssessed: true }],
      citationChasing: { backward: true, forward: true },
      checks: { corrections: true, retractions: true, supersession: true },
      qualityReview: { method: 'PRESS-derived', initialMedlineSourceId: 'search:pubmed', checklist: ['terms'], comments: [], resolution: 'accepted', resolved: true, reviewer: 'second', reviewedAt: '2026-07-15' },
    };
    expect(() => LiteratureSearchRecordSchema.parse(record)).toThrow(/translatedQuery/);
    const source = record.sources[0];
    expect(() => LiteratureSearchRecordSchema.parse({
      ...record,
      sources: [{ ...source, translationExposed: true, translatedQuery: undefined }],
    })).toThrow(/translatedQuery/);
  });

  it('never accepts authored execution results on immutable cases', () => {
    const base = {
      kind: 'edge', id: 'case:edge', tags: ['hard-limits'], inputs: { age: 121 }, expected: {},
      expectedBehavior: 'reject', tolerance: { mode: 'exact', rationale: 'error identity' },
      expectedError: { code: 'OUT_OF_HARD_LIMITS', field: 'age' },
      claimIds: ['claim:age'], sourceIds: ['source:age'], witnesses: ['input:age:hard_limits'],
    };
    for (const forbidden of ['status', 'passed', 'actual']) {
      expect(() => ValidationCaseSchema.parse({ ...base, [forbidden]: true })).toThrow();
    }
  });

  it('closes expected errors to engine discriminants', () => {
    expect(() => ValidationCaseSchema.parse({
      kind: 'edge', id: 'case:error', tags: ['hard-limits'], inputs: { age: 121 }, expected: {},
      expectedBehavior: 'reject', tolerance: { mode: 'exact', rationale: 'error identity' },
      expectedError: { code: 'MADE_UP_ERROR', field: 'age' },
      claimIds: ['claim:age'], sourceIds: ['source:age'], witnesses: ['input:age:hard_limits'],
    })).toThrow();
  });

  it('requires distinct compatibility-decision and clinical-evidence links', () => {
    expect(CompatibilityClaimLinkSchema.parse({
      compatibilityClaimId: 'claim:compatibility',
      clinicalClaimId: 'claim:clinical',
    })).toEqual({
      compatibilityClaimId: 'claim:compatibility',
      clinicalClaimId: 'claim:clinical',
    });
    expect(() => CompatibilityClaimLinkSchema.parse({
      compatibilityClaimId: 'claim:same', clinicalClaimId: 'claim:same',
    })).toThrow(/distinct/);
  });

  it('keeps compatibility decisions evidence-free', () => {
    expect(() => ClinicalClaimSchema.parse({
      id: 'claim:compatibility', scope: 'compatibility', kind: 'input',
      statement: 'Reviewed compatibility decision.',
      covers: ['compatibility:calculatorContracts:bmi'], status: 'supported',
      sourceIds: ['source:clinical'],
      locators: [{ sourceId: 'source:clinical', locator: 'Table 1' }],
      executable: false, scenarioIds: [], nonExecutableRationale: 'Decision record.',
      reviewedAt: '2026-07-17', reviewBy: '2027-07-17',
    })).toThrow(/decision records/);
  });

  it('binds compatibility decisions to exact old, replacement, and rationale text', () => {
    const claim = {
      id: 'claim:compatibility', scope: 'compatibility' as const, kind: 'input' as const,
      statement: 'Reviewed compatibility decision.',
      covers: ['compatibility:calculatorContracts:bmi'], status: 'supported' as const,
      sourceIds: [], locators: [], executable: false, scenarioIds: [],
      nonExecutableRationale: 'Decision record.', reviewedAt: '2026-07-17', reviewBy: '2027-07-17',
    };
    expect(() => ClinicalClaimSchema.parse(claim)).toThrow(/exact reviewed old behavior/);
    expect(ClinicalClaimSchema.parse({
      ...claim,
      compatibilityDecision: {
        oldBehavior: 'Old exact behavior.',
        replacement: 'New exact behavior.',
        rationale: 'Reviewed compatibility decision.',
      },
    }).compatibilityDecision).toEqual({
      oldBehavior: 'Old exact behavior.',
      replacement: 'New exact behavior.',
      rationale: 'Reviewed compatibility decision.',
    });
  });
});
