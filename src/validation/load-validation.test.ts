import { describe, expect, it } from 'vitest';
import { loadSpecs } from '../engine/load-specs.js';
import { loadAuthorityRegistry, loadValidationCatalog, loadValidationDossiers } from './load-validation.js';
import { requiredCaseTags } from './coverage.js';

describe('validation enrollment', () => {
  it('has one strict dossier per live spec and exact review-group counts', () => {
    const specs = loadSpecs();
    const dossiers = loadValidationDossiers();
    const catalog = loadValidationCatalog();
    expect([...dossiers.keys()].sort()).toEqual([...specs.keys()].sort());
    expect(catalog.groups.map((group) => group.calculatorIds.length)).toEqual([18, 13, 4, 4]);
    expect(new Set(catalog.groups.flatMap((group) => group.calculatorIds)).size).toBe(39);
    for (const [id, dossier] of dossiers) {
      expect(dossier.specVersion).toBe(specs.get(id)?.version);
      expect(dossier.enrollment).toBe('pending_independent_review');
      expect(dossier.cases.filter((testCase) => testCase.kind === 'reference').length).toBeGreaterThanOrEqual(3);
    }
    expect(loadAuthorityRegistry().get('pubmed_medline')?.discoveryOnly).toBe(true);
    expect([...requiredCaseTags(specs.get('gfr')!)]).toEqual(expect.arrayContaining([
      'required-inputs', 'hard-limits', 'unit-equivalence', 'interpretation-boundaries', 'calculator:gfr:core',
    ]));
  });
});
