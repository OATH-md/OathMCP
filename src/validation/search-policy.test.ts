import { describe, expect, it } from 'vitest';
import { LiteratureSearchRecordSchema } from './schema.js';
import { validateSearchRecord } from './search-policy.js';

function validRecord() {
  return LiteratureSearchRecordSchema.parse({
    id: 'search:test', calculatorId: 'bmi', model: 'BMI', variant: 'adult', searchedAt: '2026-07-15', reviewBy: '2027-07-15',
    sources: [{ id: 'source:medline', sourceRole: 'bibliographic_database', authorityId: 'pubmed_medline', database: 'MEDLINE', site: 'PubMed', interface: 'web', exactQuery: 'BMI derivation', translationExposed: false, filters: [], coverageTo: '2026-07-15', searchedAt: '2026-07-15', reviewer: 'one', recordsRetrieved: 2, exportDigest: 'sha256:test' }],
    accounting: { retrieved: 2, deduplicated: 1, screened: 1, fullTextAssessed: 1, excluded: 0, included: 1 },
    deduplication: { method: 'DOI and title', tool: 'Zotero', version: '7' },
    screenedCitations: [{ citationId: 'citation:one', title: 'Derivation', disposition: 'included', fullTextAssessed: true }],
    citationChasing: { backward: true, forward: true }, checks: { corrections: true, retractions: true, supersession: true },
    qualityReview: { method: 'PRESS-derived', initialMedlineSourceId: 'source:medline', checklist: ['translation', 'limits'], comments: [], resolution: 'accepted', resolved: true, reviewer: 'two', reviewedAt: '2026-07-15' },
  });
}

describe('search policy', () => {
  it('requires complete PRISMA-S accounting and resolved second review', () => {
    const record = validRecord();
    expect(validateSearchRecord(record, { roles: [], minimumExternalValidations: 0, controllingAuthorityRequired: false }).ok).toBe(true);
    const broken = { ...record, accounting: { ...record.accounting, screened: 0 }, qualityReview: { ...record.qualityReview, resolved: false } };
    const result = validateSearchRecord(broken, { roles: [], minimumExternalValidations: 0, controllingAuthorityRequired: false });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['search.accounting.screened', 'search.qa.unresolved']));
  });

  it('requires a real MEDLINE source, independent QA, reconciled dispositions, and bundle roles', () => {
    const record = validRecord();
    const source = record.sources[0]!;
    const broken = {
      ...record,
      sources: [{ ...source, database: 'Google', site: 'Web', reviewer: 'two' }],
      accounting: { ...record.accounting, included: 0, excluded: 1 },
    };
    const result = validateSearchRecord(broken, {
      roles: ['bibliographic_database', 'controlling_authority'],
      minimumExternalValidations: 0,
      controllingAuthorityRequired: true,
    });
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'search.qa.medline_source',
      'search.qa.independence',
      'search.citations.disposition',
      'search.source_role',
      'search.controlling_authority',
    ]));
  });

  it('accepts an approved regulator label as the controlling dosing authority', () => {
    const record = validRecord();
    const medline = record.sources[0]!;
    const result = validateSearchRecord({
      ...record,
      sources: [medline, {
        ...medline,
        id: 'source:label', sourceRole: 'approved_label', authorityId: 'drugs_fda', database: 'Drugs@FDA',
        site: 'FDA', exactQuery: 'current approved label', recordsRetrieved: 0, exportDigest: 'sha256:label',
      }],
    }, {
      roles: ['bibliographic_database', 'approved_label'],
      minimumExternalValidations: 0,
      controllingAuthorityRequired: true,
    });
    expect(result.issues.map((entry) => entry.code)).not.toContain('search.controlling_authority');
  });
});
