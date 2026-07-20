import { describe, expect, it, vi } from 'vitest';
import { validateClinical } from '../../src/cli/validate-clinical.js';
import { validateClinicalCatalog } from '../../src/validation/index.js';
import { run } from '../../src/engine/index.js';
import { createValidationCaseRunner } from '../../src/server/validation-case-runner.js';

describe('clinical catalog gate', () => {
  it('passes structural integrity with every calculator source verified', async () => {
    const report = await validateClinicalCatalog();
    expect(report.ok).toBe(true);
    expect(report.requestedGate).toBe('integrity');
    expect(report.calculatorReports).toHaveLength(39);
    expect(report.groupReports).toHaveLength(4);
    const states = report.calculatorReports.map((entry) => entry.reviewState.state);
    expect(new Set(states)).toEqual(new Set(['source_verified']));
  });

  it('derives all four group aggregates from their members at the scenario gate', async () => {
    const runner = await createValidationCaseRunner();
    try {
      const report = await validateClinicalCatalog({
        requireScenarioVerified: true,
        caseRunner: runner,
      });
      expect(report.ok).toBe(true);
      expect(report.calculatorReports).toHaveLength(39);
      expect(report.groupReports).toHaveLength(4);
      expect(report.groupReports.every((group) => group.state === 'scenario_verified')).toBe(true);
      expect(report.groupReports.every((group) => group.missingCalculatorIds.length === 0)).toBe(true);
    } finally {
      await runner.close();
    }
  });

  it('uses exit 0 for integrity, 1 for an unmet gate, and 2 for invalid usage', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(validateClinical([])).resolves.toBe(0);
    await expect(validateClinical(['--require-source-verified'])).resolves.toBe(0);
    await expect(validateClinical([
      '--release-attestation', 'validation/releases/0.1.0.yaml',
    ])).resolves.toBe(0);
    await expect(validateClinical(['--unknown'])).resolves.toBe(2);
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('fails validation and warns at runtime after a versioned asset review expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
    try {
      const report = await validateClinicalCatalog({ group: 'policy_versioned' });
      expect(report.ok).toBe(false);
      expect(report.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ calculatorId: 'eos', code: 'asset.review_expired' }),
      ]));
      const result = run('eos', {
        model_version: 'updated_2024_universal_gbs', baseline_incidence: '0.3',
        temperature: 37, rom_hours: 8, gestational_age: 39,
        antibiotic_status: 'none', gbs_status: 'negative', clinical_appearance: 'well_appearing',
      });
      expect(result.clinicalModel.stale).toBe(true);
      expect(result.warnings).toContain(
        'Clinical model review expired after 2026-10-13; verify the controlling source and data version before relying on this result.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
