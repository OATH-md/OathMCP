import { describe, expect, it, vi } from 'vitest';
import { loadSpec } from '../engine/load-specs.js';
import { validateDossierIntegrity } from './integrity.js';
import { loadAuthorityRegistry, loadValidationCatalog } from './load-validation.js';
import { ValidationDossierSchema } from './schema.js';

function dossier(overrides: Record<string, unknown>) {
  return ValidationDossierSchema.parse({
    calculatorId: 'bmi', specVersion: '1.0.0', clinicalModel: 'Body Mass Index (BMI)',
    variant: 'pending_exact_variant_confirmation', population: 'adult', setting: 'screening',
    assessmentTiming: 'current', endpoint: 'BMI', reviewGroup: 'formula_unit_dosing',
    enrollment: 'pending_independent_review', searchRecords: [], authoritySourceIds: [], claims: [], cases: [],
    explicitBlockers: [], ...overrides,
  });
}

function dossierFor(calculatorId: string, overrides: Record<string, unknown>) {
  const spec = loadSpec(calculatorId);
  return ValidationDossierSchema.parse({
    calculatorId,
    specVersion: spec.version,
    clinicalModel: spec.name,
    variant: 'test-variant',
    population: 'test population',
    setting: 'test setting',
    assessmentTiming: 'test timing',
    endpoint: 'test endpoint',
    reviewGroup: 'formula_unit_dosing',
    enrollment: 'pending_independent_review',
    searchRecords: [],
    authoritySourceIds: [],
    claims: [],
    cases: [],
    explicitBlockers: [],
    ...overrides,
  });
}

describe('dossier graph integrity', () => {
  it('rejects partial claim coverage and unknown/discovery-only sources', () => {
    const partial = dossier({
      authoritySourceIds: ['missing_authority', 'pubmed_medline'],
      claims: [{
        id: 'claim:partial', kind: 'formula', statement: 'partial formula claim', covers: ['formula:implementation'],
        status: 'supported', sourceIds: ['pubmed_medline'], locators: [{ sourceId: 'pubmed_medline', locator: 'record' }],
        executable: false, scenarioIds: [], nonExecutableRationale: 'not executable',
        reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
      }],
    });
    const issues = validateDossierIntegrity(partial, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry());
    expect(issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'source.unknown_authority', 'claim.missing_coverage', 'claim.unknown_source', 'claim.execution_required',
    ]));
    expect(issues.map((entry) => entry.code)).not.toContain('claim.review_cadence');
  });

  it('requires bidirectional claim/case links and feature-derived tags', () => {
    const broken = dossier({
      claims: [{
        id: 'claim:one', kind: 'formula', statement: 'formula', covers: ['formula:implementation'],
        status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'equation' }],
        executable: true, scenarioIds: ['case:other'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
      }],
      cases: [{
        kind: 'reference', id: 'case:one', tags: ['required-inputs'], inputs: {}, expected: { bmi: 1 },
        expectedBehavior: 'calculate', tolerance: { mode: 'exact', rationale: 'exact' },
        claimIds: ['claim:one'], sourceIds: ['source:one'], witnesses: ['formula:implementation'],
      }],
    });
    const issues = validateDossierIntegrity(broken, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry());
    expect(issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'claim.unknown_scenario', 'case.claim_backlink', 'case.missing_tag',
    ]));
  });

  it('rejects every broken claim, locator, source, and witness edge', () => {
    const broken = dossier({
      claims: [{
        id: 'claim:graph', kind: 'formula', statement: 'formula', covers: ['formula:implementation'],
        status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:other', locator: 'equation' }],
        executable: true, scenarioIds: ['case:graph'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
      }],
      cases: [{
        kind: 'reference', id: 'case:graph', tags: ['calculator:bmi:core'],
        inputs: { weight_kg: 70, height_cm: 170 }, expected: { bmi: 24.22 }, expectedBehavior: 'calculate',
        tolerance: { mode: 'absolute', value: 0.01, rationale: 'test' },
        claimIds: ['claim:graph'], sourceIds: ['source:two'], witnesses: ['output:bmi'],
      }],
    });
    const codes = validateDossierIntegrity(
      broken, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry(),
    ).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining([
      'claim.locator_source', 'case.claim_source', 'case.unlinked_source', 'case.unlinked_witness',
    ]));
  });

  it('does not let a self-asserted search role substitute for the authority registry', () => {
    const misleading = dossier({
      authoritySourceIds: ['pubmed_medline'],
      searchRecords: [{
        id: 'search:bmi', calculatorId: 'bmi', model: 'Body Mass Index (BMI)',
        variant: 'pending_exact_variant_confirmation', searchedAt: '2026-07-15', reviewBy: '2027-07-15',
        sources: [{
          id: 'search:pubmed', sourceRole: 'derivation', authorityId: 'pubmed_medline', database: 'MEDLINE',
          site: 'PubMed', interface: 'web', exactQuery: 'body mass index', translationExposed: false,
          filters: [], coverageTo: '2026-07-15', searchedAt: '2026-07-15', reviewer: 'reviewer',
          recordsRetrieved: 1, stableCitationIds: ['PMID:1'],
        }],
        accounting: { retrieved: 1, deduplicated: 1, screened: 1, fullTextAssessed: 1, excluded: 1, included: 0 },
        deduplication: { method: 'exact identifier', tool: 'manual', version: '1' },
        screenedCitations: [{ citationId: 'pmid:1', title: 'Excluded record', disposition: 'excluded', exclusionReason: 'wrong model', fullTextAssessed: true }],
        citationChasing: { backward: true, forward: true }, checks: { corrections: true, retractions: true, supersession: true },
        qualityReview: { method: 'PRESS-derived', initialMedlineSourceId: 'search:pubmed', checklist: ['terms'], comments: [], resolution: 'accepted', resolved: true, reviewer: 'second-reviewer', reviewedAt: '2026-07-15' },
      }],
    });
    const issues = validateDossierIntegrity(misleading, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry());
    expect(issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'search.source_role_mismatch', 'search.discovery_only_role', 'source.required_authority_role',
    ]));
  });

  it('requires a relevant witness for every executable claim and calculator-specific tag', () => {
    const unwitnessed = dossier({
      claims: [
        {
          id: 'claim:implementation', kind: 'formula', statement: 'formula', covers: ['formula:implementation'],
          status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'equation' }],
          executable: true, scenarioIds: ['case:one'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
        },
        {
          id: 'claim:model', kind: 'applicability', statement: 'model', covers: ['calculator:model'],
          status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'methods' }],
          executable: false, scenarioIds: [], nonExecutableRationale: 'descriptive identity', reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
        },
      ],
      cases: [{
        kind: 'reference', id: 'case:one', tags: ['calculator:bmi:core'], inputs: {}, expected: { bmi: 1 },
        expectedBehavior: 'calculate', tolerance: { mode: 'exact', rationale: 'exact' },
        claimIds: ['claim:implementation', 'claim:model'], sourceIds: ['source:one'], witnesses: ['calculator:model'],
      }],
    });
    const issues = validateDossierIntegrity(unwitnessed, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry());
    expect(issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'claim.unwitnessed_coverage', 'case.missing_tag',
    ]));
  });

  it('rejects future-dated evidence and review windows beyond the archetype cadence', () => {
    const dated = dossier({
      claims: [{
        id: 'claim:future', kind: 'formula', statement: 'formula', covers: ['formula:implementation'],
        status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'equation' }],
        executable: false, scenarioIds: [], nonExecutableRationale: 'pending case authoring',
        reviewedAt: '2099-01-01', reviewBy: '2101-01-01',
      }],
    });
    const issues = validateDossierIntegrity(dated, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry());
    expect(issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'claim.future_review', 'claim.review_cadence',
    ]));
  });

  it('keeps formula and coefficient claims distinct and rejects behavior-label spoofing', () => {
    const spoofed = dossier({
      claims: [
        {
          id: 'claim:formula', kind: 'formula', statement: 'formula', covers: ['formula:implementation'],
          status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'equation' }],
          executable: false, scenarioIds: [], nonExecutableRationale: 'incorrect opt-out', reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
        },
        {
          id: 'claim:coefficient', kind: 'coefficient', statement: 'exponent', covers: ['coefficient:bmi_exponent'],
          status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'coefficient' }],
          executable: false, scenarioIds: [], nonExecutableRationale: 'incorrect opt-out', reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
        },
      ],
      cases: [{
        kind: 'reference', id: 'case:spoof', tags: ['hard-limits', 'calculator:bmi:core'], inputs: { weight_kg: 70, height_cm: 170 },
        expected: { bmi: 24.22 }, expectedBehavior: 'calculate', tolerance: { mode: 'absolute', value: 0.01, rationale: 'test' },
        claimIds: ['claim:formula'], sourceIds: ['source:one'], witnesses: ['formula:implementation'],
      }],
    });
    const issues = validateDossierIntegrity(spoofed, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry());
    const codes = issues.map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['claim.execution_required', 'case.missing_tag']));
    expect(codes).not.toContain('claim.duplicate_coverage');
    expect(codes).not.toContain('claim.kind_mismatch');
  });

  it('requires an output witness to assert that exact output', () => {
    const outputSpoof = dossier({
      claims: [{
        id: 'claim:output', kind: 'outcome', statement: 'BMI output', covers: ['output:bmi'],
        status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'outcome' }],
        executable: true, scenarioIds: ['case:output'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
      }],
      cases: [{
        kind: 'reference', id: 'case:output', tags: ['required-inputs'], inputs: {}, expected: { wrong: 1 },
        expectedBehavior: 'calculate', tolerance: { mode: 'exact', rationale: 'test' },
        claimIds: ['claim:output'], sourceIds: ['source:one'], witnesses: ['output:bmi'],
      }],
    });
    const issues = validateDossierIntegrity(outputSpoof, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry());
    expect(issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'case.unproven_witness', 'case.unknown_output', 'claim.unwitnessed_coverage',
    ]));
  });

  it('binds band witnesses to the exact declared interpretation', () => {
    const wrongBand = dossier({
      claims: [{
        id: 'claim:band', kind: 'band', statement: 'obesity band', covers: ['band:calculator:0'],
        status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'table' }],
        executable: true, scenarioIds: ['case:band'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
      }],
      cases: [{
        kind: 'reference', id: 'case:band', tags: ['interpretation-boundaries'],
        inputs: { weight_kg: 70, height_cm: 170 }, expected: { bmi: 24.22 }, expectedBehavior: 'calculate',
        expectedInterpretations: [{
          output: 'bmi', code: 'bmi_band_3', kind: 'class', label: 'Normal weight', severity: 'normal',
        }],
        tolerance: { mode: 'absolute', value: 0.01, rationale: 'test' },
        claimIds: ['claim:band'], sourceIds: ['source:one'], witnesses: ['band:calculator:0'],
      }],
    });
    const issues = validateDossierIntegrity(wrongBand, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry());
    expect(issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'case.unproven_witness', 'claim.unwitnessed_coverage',
    ]));
  });

  it('binds cutoff witnesses to complete declared interpretation metadata', () => {
    const wrongCutoff = dossier({
      claims: [{
        id: 'claim:cutoff', kind: 'cutoff', statement: 'obesity cutoff', covers: ['cutoff:bmi_band_1'],
        status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'table' }],
        executable: true, scenarioIds: ['case:cutoff'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
      }],
      cases: [{
        kind: 'reference', id: 'case:cutoff', tags: ['interpretation-boundaries'],
        inputs: { weight_kg: 70, height_cm: 170 }, expected: { bmi: 24.22 }, expectedBehavior: 'calculate',
        expectedInterpretations: [{
          output: 'bmi', code: 'bmi_band_1', kind: 'class', label: 'Wrong label', severity: 'normal',
        }],
        tolerance: { mode: 'absolute', value: 0.01, rationale: 'test' },
        claimIds: ['claim:cutoff'], sourceIds: ['source:one'], witnesses: ['cutoff:bmi_band_1'],
      }],
    });
    const codes = validateDossierIntegrity(
      wrongCutoff, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry(),
    ).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['case.unproven_witness', 'claim.unwitnessed_coverage']));
  });

  it('does not let unrelated warnings or constraints witness sibling rules', () => {
    const spec = loadSpec('carboplatin_auc');
    const warningClaim = {
      id: 'claim:warning', kind: 'warning' as const, statement: 'warning', covers: ['warning:0'],
      status: 'supported' as const, sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'rule' }],
      executable: true, scenarioIds: ['case:warning'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
    };
    const constraintClaim = {
      id: 'claim:constraint', kind: 'input' as const, statement: 'constraint', covers: ['constraint:0'],
      status: 'supported' as const, sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'rule' }],
      executable: true, scenarioIds: ['case:constraint'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
    };
    const mutated = dossierFor('carboplatin_auc', {
      claims: [warningClaim, constraintClaim],
      cases: [
        {
          kind: 'reference', id: 'case:warning', tags: ['plausibility'], inputs: {}, expected: { dose: 1 },
          expectedBehavior: 'warn', expectedWarnings: ['ADDIKD'],
          tolerance: { mode: 'exact', rationale: 'test' }, claimIds: ['claim:warning'],
          sourceIds: ['source:one'], witnesses: ['warning:0'],
        },
        {
          kind: 'edge', id: 'case:constraint', tags: ['constraints'], inputs: {}, expected: {},
          expectedBehavior: 'reject', expectedError: {
            code: 'CONSTRAINT_FAILED', field: 'patient_bsa', messageIncludes: 'Patient BSA',
          },
          tolerance: { mode: 'exact', rationale: 'test' }, claimIds: ['claim:constraint'],
          sourceIds: ['source:one'], witnesses: ['constraint:0'],
        },
      ],
    });
    const codes = validateDossierIntegrity(
      mutated, spec, loadValidationCatalog(), loadAuthorityRegistry(),
    ).map((entry) => entry.code);
    expect(codes.filter((code) => code === 'case.unproven_witness')).toHaveLength(2);
  });

  it('rejects noncanonical and nonexistent claim-key namespaces', () => {
    const invalidKeys = [
      'warning:999', 'band:bmi:999', 'coefficient:bmi:exponent',
      'coefficient:made_up', 'recommendation:made_up', 'cutoff:made_up', 'cap:not_declared',
    ];
    for (const [index, key] of invalidKeys.entries()) {
      const invalid = dossier({
        claims: [{
          id: `claim:invalid:${index}`, kind: key.startsWith('warning:') ? 'warning' :
            key.startsWith('band:') || key.startsWith('cutoff:') ? 'band' :
              key.startsWith('cap:') ? 'cap' : key.startsWith('recommendation:') ? 'recommendation' : 'coefficient',
          statement: 'invalid namespace', covers: [key], status: 'supported', sourceIds: ['source:one'],
          locators: [{ sourceId: 'source:one', locator: 'test' }], executable: false,
          scenarioIds: [], nonExecutableRationale: 'test mutation', reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
        }],
      });
      const codes = validateDossierIntegrity(invalid, loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry())
        .map((entry) => entry.code);
      expect(codes, key).toContain('claim.unknown_coverage');
    }
  });

  it('requires three source-linked reference cases before scenario verification', () => {
    const claim = {
      id: 'claim:formula', kind: 'formula' as const, statement: 'formula', covers: ['formula:implementation'],
      status: 'supported' as const, sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'equation' }],
      executable: true, scenarioIds: ['case:1', 'case:2'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
    };
    const cases = [1, 2].map((number) => ({
      kind: 'reference' as const, id: `case:${number}`, tags: ['calculator:bmi:core'],
      inputs: { weight_kg: 70, height_cm: 170 }, expected: { bmi: 24.22 }, expectedBehavior: 'calculate' as const,
      tolerance: { mode: 'absolute' as const, value: 0.01, rationale: 'test' },
      claimIds: ['claim:formula'], sourceIds: ['source:one'], witnesses: ['formula:implementation'],
    }));
    const issues = validateDossierIntegrity(
      dossier({ claims: [claim], cases }),
      loadSpec('bmi'),
      loadValidationCatalog(),
      loadAuthorityRegistry(),
    );
    expect(issues.map((entry) => entry.code)).toContain('case.insufficient_reference_cases');
  });

  it.each([
    ['required-inputs', 'bmi'],
    ['hard-limits', 'bmi'],
    ['plausibility', 'bmi'],
    ['defaults', 'aa_gradient'],
    ['aliases', 'bmi'],
    ['unit-equivalence', 'gfr'],
    ['interpretation-boundaries', 'bmi'],
    ['constraints', 'carboplatin_auc'],
    ['conditional-output', 'abg'],
    ['agent-applicability', 'bmi'],
    ['calculator:bmi:core', 'bmi'],
  ] as const)('requires the feature-derived %s tag', (tag, calculatorId) => {
    const spec = loadSpec(calculatorId);
    const incomplete = dossierFor(calculatorId, {
      claims: [{
        id: 'claim:formula', kind: 'formula', statement: 'formula', covers: ['formula:implementation'],
        status: 'supported', sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'equation' }],
        executable: true, scenarioIds: ['case:missing'], reviewedAt: '2026-07-15', reviewBy: '2027-07-15',
      }],
    });
    const issue = validateDossierIntegrity(
      incomplete, spec, loadValidationCatalog(), loadAuthorityRegistry(),
    ).find((entry) => entry.code === 'case.missing_tag' && entry.path === tag);
    expect(issue, `${calculatorId}:${tag}`).toBeDefined();
  });

  it('uses exact UTC dates for nested future checks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T23:59:59Z'));
    try {
      const authorities = new Map(loadAuthorityRegistry());
      const pubmed = authorities.get('pubmed_medline')!;
      authorities.set('pubmed_medline', { ...pubmed, checkedAt: '2026-07-16', reviewBy: '2026-08-01' });
      const future = dossier({
        authoritySourceIds: ['pubmed_medline'],
        searchRecords: [{
          id: 'search:future', calculatorId: 'bmi', model: 'Body Mass Index (BMI)',
          variant: 'pending_exact_variant_confirmation', searchedAt: '2026-07-16', reviewBy: '2027-07-15',
          sources: [{
            id: 'source:future', sourceRole: 'bibliographic_database', authorityId: 'pubmed_medline',
            database: 'MEDLINE', site: 'PubMed', interface: 'web', exactQuery: 'BMI', translationExposed: false,
            filters: [], coverageFrom: '2026-07-16', coverageTo: '2026-07-16', searchedAt: '2026-07-16',
            reviewer: 'one', recordsRetrieved: 1, stableCitationIds: ['PMID:1'],
          }],
          accounting: { retrieved: 1, deduplicated: 1, screened: 1, fullTextAssessed: 1, excluded: 1, included: 0 },
          deduplication: { method: 'PMID', tool: 'manual', version: '1' },
          screenedCitations: [{ citationId: 'pmid:1', title: 'Excluded', disposition: 'excluded', exclusionReason: 'wrong model', fullTextAssessed: true }],
          citationChasing: { backward: true, forward: true }, checks: { corrections: true, retractions: true, supersession: true },
          qualityReview: { method: 'PRESS-derived', initialMedlineSourceId: 'source:future', checklist: ['terms'], comments: [], resolution: 'accepted', resolved: true, reviewer: 'two', reviewedAt: '2026-07-16' },
        }],
        claims: [{
          id: 'claim:future:nested', kind: 'formula', statement: 'formula', covers: ['formula:implementation'],
          status: 'supported', sourceIds: ['pubmed_medline'], locators: [{ sourceId: 'pubmed_medline', locator: 'record' }],
          executable: false, scenarioIds: [], nonExecutableRationale: 'test', reviewedAt: '2026-07-16', reviewBy: '2027-07-15',
        }],
      });
      const codes = validateDossierIntegrity(future, loadSpec('bmi'), loadValidationCatalog(), authorities)
        .map((entry) => entry.code);
      expect(codes).toEqual(expect.arrayContaining([
        'source.future_checked_at', 'search.future_date', 'search.future_review',
        'search.source_future_date', 'search.future_coverage', 'claim.future_review',
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['policy_versioned', '2024-01-31', '2024-04-30', '2024-05-01'],
    ['interpreter_conditional', '2024-01-01', '2024-06-29', '2024-06-30'],
    ['formula_unit_dosing', '2024-02-29', '2025-02-28', '2025-03-01'],
  ] as const)('keeps exact UTC cadence boundaries for %s', (reviewGroup, reviewedAt, exact, over) => {
    const claim = (reviewBy: string) => ({
      id: 'claim:cadence', kind: 'formula' as const, statement: 'formula', covers: ['formula:implementation'],
      status: 'supported' as const, sourceIds: ['source:one'], locators: [{ sourceId: 'source:one', locator: 'equation' }],
      executable: false, scenarioIds: [], nonExecutableRationale: 'test', reviewedAt, reviewBy,
    });
    const exactCodes = validateDossierIntegrity(
      dossier({ reviewGroup, claims: [claim(exact)] }), loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry(),
    ).map((entry) => entry.code);
    const overCodes = validateDossierIntegrity(
      dossier({ reviewGroup, claims: [claim(over)] }), loadSpec('bmi'), loadValidationCatalog(), loadAuthorityRegistry(),
    ).map((entry) => entry.code);
    expect(exactCodes).not.toContain('claim.review_cadence');
    expect(overCodes).toContain('claim.review_cadence');
  });
});
