import { describe, expect, it, vi } from 'vitest';
import { ReleaseEvidenceAttestationSchema } from './schema.js';
import {
  validateReleaseEvidenceAttestation,
  validateReleaseReviewCurrentness,
  validateReleaseSourceCurrentness,
  validateReleaseSourceVersions,
} from './release-attestation.js';

describe('release evidence attestation', () => {
  it('pins package version, currentness, and unresolved changes', () => {
    const attestation = ReleaseEvidenceAttestationSchema.parse({
      schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt: new Date().toISOString().slice(0, 10), networkCheckedAt: new Date().toISOString().slice(0, 10), reviewer: 'reviewer',
      currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi'], sourceVersions: { bmi: 'source-v1' },
    });
    expect(validateReleaseEvidenceAttestation(attestation, '0.1.0').ok).toBe(true);
    expect(validateReleaseEvidenceAttestation({ ...attestation, currentnessConfirmed: false }, '0.2.0').errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(['release.version_mismatch', 'release.currentness']));
  });

  it('rejects stale checks', () => {
    const stale = ReleaseEvidenceAttestationSchema.parse({
      schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt: '2000-01-01', networkCheckedAt: '2000-01-01', reviewer: 'reviewer',
      currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi', 'gfr'], sourceVersions: { bmi: 'source-v1' },
    });
    expect(validateReleaseEvidenceAttestation(stale, '0.1.0').errors.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['release.stale_attestation']),
    );
  });

  it('requires exact versions for every authority source actually used', () => {
    const attestation = ReleaseEvidenceAttestationSchema.parse({
      schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt: new Date().toISOString().slice(0, 10), networkCheckedAt: new Date().toISOString().slice(0, 10), reviewer: 'reviewer',
      currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi'], sourceVersions: { 'bmi:made-up': 'v1' },
    });
    const errors = validateReleaseSourceVersions(attestation, new Map([['bmi', new Map([['source:formula', 'v2']])]]));
    expect(errors.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'release.missing_authority_version', 'release.unknown_source_version',
    ]));
  });

  it('rejects the wrong version for a real enrolled source key', () => {
    const attestation = ReleaseEvidenceAttestationSchema.parse({
      schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt: new Date().toISOString().slice(0, 10), networkCheckedAt: new Date().toISOString().slice(0, 10), reviewer: 'reviewer',
      currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi'], sourceVersions: { 'bmi:source:formula': 'wrong' },
    });
    expect(validateReleaseSourceVersions(
      attestation,
      new Map([['bmi', new Map([['source:formula', 'expected-hash']])]]),
    ).map((entry) => entry.code)).toContain('release.source_version_mismatch');
  });

  it('rejects conflicting shared and calculator-scoped versions', () => {
    const attestation = ReleaseEvidenceAttestationSchema.parse({
      schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt: new Date().toISOString().slice(0, 10), networkCheckedAt: new Date().toISOString().slice(0, 10), reviewer: 'reviewer',
      currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi'],
      sourceVersions: { 'source:formula': 'wrong', 'bmi:source:formula': 'expected-hash' },
    });
    expect(validateReleaseSourceVersions(
      attestation,
      new Map([['bmi', new Map([['source:formula', 'expected-hash']])]]),
    ).map((entry) => entry.code)).toContain('release.conflicting_source_version');
  });

  it('rejects sources checked after the attested network review', () => {
    const attestation = ReleaseEvidenceAttestationSchema.parse({
      schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt: '2026-07-16', networkCheckedAt: '2026-07-16', reviewer: 'reviewer',
      currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi'], sourceVersions: { source: 'v1' },
    });
    const errors = validateReleaseSourceCurrentness(
      attestation,
      new Map([['bmi', new Map([['source', '2026-07-17']])]]),
    );
    expect(errors.map((entry) => entry.code)).toContain('release.source_checked_after_network_review');
  });

  it('rejects dossier claims reviewed after attestation creation', () => {
    const attestation = ReleaseEvidenceAttestationSchema.parse({
      schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt: '2026-07-16', networkCheckedAt: '2026-07-16', reviewer: 'reviewer',
      currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi'], sourceVersions: { source: 'v1' },
    });
    const errors = validateReleaseReviewCurrentness(
      attestation,
      new Map([['bmi', new Map([['claim:compatibility', '2026-07-17']])]]),
    );
    expect(errors.map((entry) => entry.code)).toContain('release.claim_reviewed_after_attestation');
  });

  it('uses exact UTC calendar boundaries for currentness', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T23:59:59Z'));
    try {
      const attestation = (checkedAt: string) => ReleaseEvidenceAttestationSchema.parse({
        schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt, networkCheckedAt: checkedAt, reviewer: 'reviewer',
        currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi'], sourceVersions: { bmi: 'source-v1' },
      });
      expect(validateReleaseEvidenceAttestation(attestation('2026-07-15'), '0.1.0').ok).toBe(true);
      expect(validateReleaseEvidenceAttestation(attestation('2026-07-16'), '0.1.0').errors.map((entry) => entry.code))
        .toContain('release.stale_attestation');
      expect(validateReleaseEvidenceAttestation(attestation('2026-04-16'), '0.1.0').ok).toBe(true);
      expect(validateReleaseEvidenceAttestation(attestation('2026-04-15'), '0.1.0').errors.map((entry) => entry.code))
        .toContain('release.stale_attestation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the attested reviewer time zone for the release calendar date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T23:30:00Z'));
    try {
      const attestation = ReleaseEvidenceAttestationSchema.parse({
        schemaVersion: '1.0', packageVersion: '0.1.0', checkedAt: '2026-07-17', networkCheckedAt: '2026-07-16', reviewer: 'reviewer', reviewerTimeZone: 'Asia/Riyadh',
        currentnessConfirmed: true, unresolvedChanges: [], calculatorIds: ['bmi'], sourceVersions: { bmi: 'source-v1' },
      });
      expect(validateReleaseEvidenceAttestation(attestation, '0.1.0').ok).toBe(true);
      expect(validateReleaseEvidenceAttestation({ ...attestation, reviewerTimeZone: 'Not/A_Zone' }, '0.1.0')
        .errors.map((entry) => entry.code)).toContain('release.invalid_reviewer_timezone');
    } finally {
      vi.useRealTimers();
    }
  });
});
