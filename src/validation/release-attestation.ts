import type { ReleaseEvidenceAttestation, ReviewIssue, ValidationReport } from './schema.js';

export function validateReleaseSourceVersions(
  attestation: ReleaseEvidenceAttestation,
  requiredByCalculator: ReadonlyMap<string, ReadonlyMap<string, string>>,
): ReviewIssue[] {
  const errors: ReviewIssue[] = [];
  const allowedKeys = new Set<string>();
  for (const [calculatorId, sources] of requiredByCalculator) {
    for (const [sourceId, expectedVersion] of sources) {
      const scopedKey = `${calculatorId}:${sourceId}`;
      allowedKeys.add(sourceId);
      allowedKeys.add(scopedKey);
      const scopedVersion = attestation.sourceVersions[scopedKey];
      const sharedVersion = attestation.sourceVersions[sourceId];
      if (scopedVersion !== undefined && sharedVersion !== undefined && scopedVersion !== sharedVersion) {
        errors.push({
          code: 'release.conflicting_source_version',
          message: `release attestation gives conflicting scoped and shared versions for ${sourceId}`,
          severity: 'error',
          calculatorId,
        });
      }
      const actualVersion = scopedVersion ?? sharedVersion;
      if (actualVersion === undefined) {
        errors.push({
          code: 'release.missing_authority_version',
          message: `release attestation omits source version ${sourceId} for ${calculatorId}`,
          severity: 'error',
          calculatorId,
        });
      } else if (actualVersion !== expectedVersion) {
        errors.push({
          code: 'release.source_version_mismatch',
          message: `release attestation has ${actualVersion} for ${sourceId}; expected ${expectedVersion}`,
          severity: 'error',
          calculatorId,
        });
      }
    }
  }
  for (const key of Object.keys(attestation.sourceVersions)) {
    if (!allowedKeys.has(key)) {
      errors.push({
        code: 'release.unknown_source_version',
        message: `release attestation source version key ${key} is not used by an enrolled dossier`,
        severity: 'error',
      });
    }
  }
  return errors;
}

export function validateReleaseSourceCurrentness(
  attestation: ReleaseEvidenceAttestation,
  checkedAtByCalculator: ReadonlyMap<string, ReadonlyMap<string, string>>,
): ReviewIssue[] {
  const errors: ReviewIssue[] = [];
  for (const [calculatorId, sources] of checkedAtByCalculator) {
    for (const [sourceId, checkedAt] of sources) {
      if (checkedAt > attestation.networkCheckedAt) {
        errors.push({
          code: 'release.source_checked_after_network_review',
          message: `${sourceId} was checked ${checkedAt}, after the release network review ${attestation.networkCheckedAt}`,
          severity: 'error',
          calculatorId,
        });
      }
    }
  }
  return errors;
}

export function validateReleaseReviewCurrentness(
  attestation: ReleaseEvidenceAttestation,
  reviewedAtByCalculator: ReadonlyMap<string, ReadonlyMap<string, string>>,
): ReviewIssue[] {
  const errors: ReviewIssue[] = [];
  for (const [calculatorId, claims] of reviewedAtByCalculator) {
    for (const [claimId, reviewedAt] of claims) {
      if (reviewedAt > attestation.checkedAt) {
        errors.push({
          code: 'release.claim_reviewed_after_attestation',
          message: `${claimId} was reviewed ${reviewedAt}, after the release attestation ${attestation.checkedAt}`,
          severity: 'error',
          calculatorId,
        });
      }
    }
  }
  return errors;
}

function calendarDateInTimeZone(date: Date, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    return year === undefined || month === undefined || day === undefined
      ? undefined
      : `${year}-${month}-${day}`;
  } catch {
    return undefined;
  }
}

export function validateReleaseEvidenceAttestation(
  attestation: ReleaseEvidenceAttestation,
  packageVersion: string,
): ValidationReport {
  const errors: ReviewIssue[] = [];
  if (attestation.packageVersion !== packageVersion) {
    errors.push({
      code: 'release.version_mismatch',
      message: `attestation ${attestation.packageVersion} does not match package ${packageVersion}`,
      severity: 'error',
    });
  }
  if (!attestation.currentnessConfirmed) {
    errors.push({ code: 'release.currentness', message: 'release currentness is not confirmed', severity: 'error' });
  }
  if (attestation.unresolvedChanges.length > 0) {
    errors.push({ code: 'release.unresolved_changes', message: 'release has unresolved upstream changes', severity: 'error' });
  }
  const today = calendarDateInTimeZone(new Date(), attestation.reviewerTimeZone);
  if (today === undefined) {
    errors.push({ code: 'release.invalid_reviewer_timezone', message: 'release reviewer time zone must be a valid IANA time zone', severity: 'error' });
  }
  if (attestation.networkCheckedAt > attestation.checkedAt) {
    errors.push({ code: 'release.network_after_attestation', message: 'network check cannot follow attestation creation', severity: 'error' });
  }
  const ageDays = today === undefined ? Number.POSITIVE_INFINITY : (
    new Date(`${today}T00:00:00Z`).getTime() -
    new Date(`${attestation.networkCheckedAt}T00:00:00Z`).getTime()
  ) / 86_400_000;
  if (today === undefined || attestation.checkedAt > today || attestation.networkCheckedAt > today || ageDays > 90) {
    errors.push({ code: 'release.stale_attestation', message: 'release evidence check must be current within 90 days and not future-dated', severity: 'error' });
  }
  if (new Set(attestation.calculatorIds).size !== attestation.calculatorIds.length) {
    errors.push({ code: 'release.duplicate_calculator', message: 'release calculator IDs must be unique', severity: 'error' });
  }
  return {
    ok: errors.length === 0,
    requestedGate: 'release',
    calculatorReports: [],
    groupReports: [],
    errors,
    warnings: [],
  };
}
