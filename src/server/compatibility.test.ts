import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadValidationDossiers } from '../validation/load-validation.js';
import {
  CompatibilityManifestSchema,
  captureCompatibilitySnapshot,
  compatibilitySurfaceDigest,
  validateCompatibilitySnapshot,
  type CompatibilityManifest,
  type CompatibilitySnapshot,
} from './compatibility.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function linkedBreak(
  oldSnapshot: CompatibilitySnapshot,
  newSnapshot: CompatibilitySnapshot,
  surface: string,
): CompatibilityManifest['allowedSafetyBreaks'][number] {
  return {
    id: 'break:one',
    calculatorId: 'bmi',
    compatibilityClaimId: 'claim:compatibility',
    clinicalClaimId: 'claim:clinical',
    clinicalClaimCoverage: 'input:weight_kg',
    surface,
    oldBehavior: 'old exact behavior',
    replacement: 'new exact behavior',
    rationale: 'clinically required correction',
    oldValueDigest: compatibilitySurfaceDigest(oldSnapshot, surface),
    replacementValueDigest: compatibilitySurfaceDigest(newSnapshot, surface),
  };
}

function linkedDossier(
  surface: string,
  clinicalScope: 'clinical' | 'compatibility' = 'clinical',
  clinicalCoverage = 'input:weight_kg',
) {
  return new Map([['bmi', { claims: [
    {
      id: 'claim:compatibility', scope: 'compatibility', status: 'supported',
      statement: 'clinically required correction', covers: [`compatibility:${surface}`],
      sourceIds: [], locators: [],
      compatibilityDecision: {
        oldBehavior: 'old exact behavior', replacement: 'new exact behavior',
        rationale: 'clinically required correction',
      },
    },
    {
      id: 'claim:clinical', scope: clinicalScope, status: 'supported', covers: [clinicalCoverage],
      sourceIds: ['source:primary'], locators: [{ sourceId: 'source:primary', locator: 'Table 1' }],
    },
  ] }]]) as never;
}

describe('1.0 compatibility manifest', () => {
  let snapshot: CompatibilitySnapshot;
  let manifest: CompatibilityManifest;
  let dossiers: ReturnType<typeof loadValidationDossiers>;

  beforeAll(async () => {
    snapshot = await captureCompatibilitySnapshot('full');
    dossiers = loadValidationDossiers();
    manifest = CompatibilityManifestSchema.parse(
      parseYaml(readFileSync(join(ROOT, 'validation/compatibility/1.0.yaml'), 'utf8')),
    );
  });

  it('pins the pre-migration full MCP surface and exact historical safety breaks', () => {
    expect(validateCompatibilitySnapshot(snapshot, manifest, dossiers)).toEqual({ ok: true, differences: [] });
  });

  it('requires a dossier-linked allowlist entry for an intentional safety break', () => {
    const changed = { ...snapshot, promptNames: [...snapshot.promptNames, 'unexpected'] };
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot, allowedSafetyBreaks: [],
    });
    expect(report.ok).toBe(false);
    expect(report.differences).toContain('changed compatibility surface: promptNames:unexpected');
  });

  it('allows only an exact surface linked to distinct compatibility and clinical claims', () => {
    const changed = { ...snapshot, promptNames: [...snapshot.promptNames, 'intentional'] };
    const surface = 'promptNames:intentional';
    const exactManifest = {
      schemaVersion: '1.0' as const,
      capturedAt: '2026-07-15',
      snapshot,
      allowedSafetyBreaks: [linkedBreak(snapshot, changed, surface)],
    };
    expect(validateCompatibilitySnapshot(changed, exactManifest, linkedDossier(surface)))
      .toEqual({ ok: true, differences: [] });
  });

  it('rejects a compatibility claim for a different surface', () => {
    const changed = { ...snapshot, promptNames: [...snapshot.promptNames, 'intentional'] };
    const surface = 'promptNames:intentional';
    const dossiers = linkedDossier('safeAliases:bmi.weight_kg');
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot,
      allowedSafetyBreaks: [linkedBreak(snapshot, changed, surface)],
    }, dossiers);

    expect(report.ok).toBe(false);
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.stringContaining(`missing supported compatibility claim for compatibility:${surface}`),
      `changed compatibility surface: ${surface}`,
    ]));
  });

  it('never lets the compatibility decision masquerade as the clinical evidence claim', () => {
    const changed = { ...snapshot, promptNames: [...snapshot.promptNames, 'intentional'] };
    const surface = 'promptNames:intentional';
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot,
      allowedSafetyBreaks: [linkedBreak(snapshot, changed, surface)],
    }, linkedDossier(surface, 'compatibility'));
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.stringContaining('missing independently sourced clinical claim'),
      `changed compatibility surface: ${surface}`,
    ]));
  });

  it('rejects a sourced clinical claim for an unrelated behavior', () => {
    const changed = { ...snapshot, promptNames: [...snapshot.promptNames, 'intentional'] };
    const surface = 'promptNames:intentional';
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot,
      allowedSafetyBreaks: [linkedBreak(snapshot, changed, surface)],
    }, linkedDossier(surface, 'clinical', 'formula:unrelated'));
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.stringContaining('missing independently sourced clinical claim'),
      `changed compatibility surface: ${surface}`,
    ]));
  });

  it('binds the allowlist rationale to the reviewed compatibility decision', () => {
    const changed = { ...snapshot, promptNames: [...snapshot.promptNames, 'intentional'] };
    const surface = 'promptNames:intentional';
    const safetyBreak = linkedBreak(snapshot, changed, surface);
    safetyBreak.rationale = 'unreviewed alternate rationale';
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot,
      allowedSafetyBreaks: [safetyBreak],
    }, linkedDossier(surface));
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.stringContaining('missing supported compatibility claim'),
      `changed compatibility surface: ${surface}`,
    ]));
  });

  it('binds the old and replacement descriptions to the reviewed compatibility decision', () => {
    const changed = { ...snapshot, promptNames: [...snapshot.promptNames, 'intentional'] };
    const surface = 'promptNames:intentional';
    const safetyBreak = linkedBreak(snapshot, changed, surface);
    safetyBreak.oldBehavior = 'unreviewed old description';
    safetyBreak.replacement = 'unreviewed replacement description';
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot,
      allowedSafetyBreaks: [safetyBreak],
    }, linkedDossier(surface));
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.stringContaining('missing supported compatibility claim'),
      `changed compatibility surface: ${surface}`,
    ]));
  });

  it('rejects a linked break when either frozen-value digest drifts', () => {
    const changed = { ...snapshot, promptNames: [...snapshot.promptNames, 'intentional'] };
    const surface = 'promptNames:intentional';
    const safetyBreak = linkedBreak(snapshot, changed, surface);
    safetyBreak.replacementValueDigest = compatibilitySurfaceDigest(snapshot, surface);
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot,
      allowedSafetyBreaks: [safetyBreak],
    }, linkedDossier(surface));
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.stringContaining('old/replacement surface digests do not match'),
      `changed compatibility surface: ${surface}`,
    ]));
  });

  it('does not treat newly accepted aliases as additive without exact review', () => {
    const changed = structuredClone(snapshot);
    changed.safeAliases.bmi = { ...changed.safeAliases.bmi, weight_kg: ['patient_weight'] };
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot, allowedSafetyBreaks: [],
    });
    expect(report).toEqual({
      ok: false,
      differences: ['changed compatibility surface: safeAliases:bmi.weight_kg'],
    });
  });

  type CalculatorContract = CompatibilitySnapshot['calculatorContracts'][string]['directTool'];
  const contractMutations: Array<[string, string, (contract: CalculatorContract) => void]> = [
    ['requiredness', 'bmi', (contract) => { contract.inputs.weight_kg!.required = false; }],
    ['input names', 'bmi', (contract) => {
      contract.inputs.stature_cm = contract.inputs.height_cm!;
      delete contract.inputs.height_cm;
    }],
    ['input kinds', 'bmi', (contract) => { contract.inputs.weight_kg!.kind = 'integer'; }],
    ['enum canonical values', 'child_pugh', (contract) => {
      contract.inputs.ascites!.enumValues!.push('trace');
    }],
    ['enum aliases', 'apgar', (contract) => {
      contract.inputs.pulse!.enumAliases!.at_least_100!.push('one_hundred_or_more');
    }],
    ['quantity units', 'gfr', (contract) => {
      contract.inputs.creatinine!.quantity!.acceptedUnits.push('mol/L');
    }],
    ['defaults', 'free_water_deficit', (contract) => { contract.inputs.ideal_sodium!.default = 139; }],
    ['requiredWhen constraints', 'bmi', (contract) => {
      contract.conditionalRequirements.push({
        kind: 'requiredWhen', field: 'weight_kg', when: '>0', required: ['height_cm'], message: 'required',
      });
    }],
    ['compare constraints', 'bmi', (contract) => {
      contract.conditionalRequirements.push({
        kind: 'compare', left: 'weight_kg', operator: '>', right: 'height_cm', message: 'compare',
      });
    }],
    ['atLeastOne constraints', 'bmi', (contract) => {
      contract.conditionalRequirements.push({
        kind: 'atLeastOne', fields: ['weight_kg', 'height_cm'], message: 'one',
      });
    }],
    ['requireValueWhen constraints', 'bmi', (contract) => {
      contract.conditionalRequirements.push({
        kind: 'requireValueWhen', field: 'weight_kg', when: '>0', target: 'height_cm', value: 170,
        message: 'value',
      });
    }],
    ['forbidValueWhen constraints', 'bmi', (contract) => {
      contract.conditionalRequirements.push({
        kind: 'forbidValueWhen', field: 'weight_kg', when: '>0', target: 'height_cm', value: 170,
        message: 'forbid value',
      });
    }],
    ['requireAtLeastValuesWhen constraints', 'bmi', (contract) => {
      contract.conditionalRequirements.push({
        kind: 'requireAtLeastValuesWhen', field: 'weight_kg', when: '>0',
        targets: [{ field: 'height_cm', value: 170 }], minimum: 1, message: 'minimum',
      });
    }],
    ['forbidPresentWhen constraints', 'bmi', (contract) => {
      contract.conditionalRequirements.push({
        kind: 'forbidPresentWhen', field: 'weight_kg', when: '>0', forbidden: ['height_cm'],
        message: 'forbid present',
      });
    }],
    ['output names', 'bmi', (contract) => {
      contract.outputs.body_mass_index = contract.outputs.bmi!;
      delete contract.outputs.bmi;
    }],
    ['additional output names', 'bmi', (contract) => {
      contract.outputs.body_mass_index = structuredClone(contract.outputs.bmi!);
    }],
    ['output kinds', 'bmi', (contract) => { contract.outputs.bmi!.kind = 'integer'; }],
    ['output availability', 'bmi', (contract) => {
      contract.outputs.bmi!.availability = {
        kind: 'whenAllInputsPresent', fields: ['weight_kg', 'height_cm'],
      };
    }],
  ];

  it.each(contractMutations)('rejects full-direct %s mutations', (_label, calculatorId, mutate) => {
    const changed = structuredClone(snapshot);
    mutate(changed.calculatorContracts[calculatorId]!.directTool);
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot, allowedSafetyBreaks: [],
    });
    expect(report.ok).toBe(false);
    expect(report.differences.some((difference) => difference.startsWith('changed compatibility surface: calculatorContracts:'))).toBe(true);
  });

  it.each(contractMutations)('rejects compact-dispatch %s mutations', (_label, calculatorId, mutate) => {
    const changed = structuredClone(snapshot);
    mutate(changed.calculatorContracts[calculatorId]!.compactDispatcher);
    const report = validateCompatibilitySnapshot(changed, {
      schemaVersion: '1.0', capturedAt: '2026-07-15', snapshot, allowedSafetyBreaks: [],
    });
    expect(report.ok).toBe(false);
    expect(report.differences.some((difference) =>
      difference.startsWith(`changed compatibility surface: calculatorContracts:${calculatorId}.compactDispatcher`),
    )).toBe(true);
  });

  it('rejects an unrelated calculator contract change beside an exact safety break', () => {
    const changed = structuredClone(snapshot);
    changed.calculatorContracts.bsa!.directTool.outputs.bsa!.kind = 'integer';
    const report = validateCompatibilitySnapshot(changed, manifest, dossiers);
    expect(report.differences).toContain('changed compatibility surface: calculatorContracts:bsa.directTool.outputs.bsa');
  });
});
