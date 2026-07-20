import { loadSpecs } from '../engine/load-specs.js';
import { clinicalDataAssetFor, clinicalDataAssetProblems } from '../clinical-data/index.js';
import { createRequire } from 'node:module';
import { executeValidationCases } from './case-runner.js';
import { validateDossierIntegrity } from './integrity.js';
import { loadAuthorityRegistry, loadValidationCatalog, loadValidationDossiers } from './load-validation.js';
import {
  validateReleaseEvidenceAttestation,
  validateReleaseReviewCurrentness,
  validateReleaseSourceCurrentness,
  validateReleaseSourceVersions,
} from './release-attestation.js';
import { deriveGroupReadiness, deriveReviewStateWithIssues } from './state.js';
import type {
  CalculatorValidationReport,
  ReleaseEvidenceAttestation,
  ReviewIssue,
  ValidationCaseRunner,
  ValidationReport,
} from './schema.js';

export * from './schema.js';
export { executeValidationCases } from './case-runner.js';
export { requiredCaseTags, requiredClinicalClaimKeys } from './coverage.js';
export { loadAuthoritativeReferenceCases, loadAuthorityRegistry, loadValidationCatalog, loadValidationDossiers } from './load-validation.js';
export {
  validateReleaseEvidenceAttestation,
  validateReleaseReviewCurrentness,
  validateReleaseSourceCurrentness,
  validateReleaseSourceVersions,
} from './release-attestation.js';
export { requiredSourceBundle, validateSearchRecord } from './search-policy.js';
export { validateDossierIntegrity } from './integrity.js';
export { deriveGroupReadiness, deriveReviewState } from './state.js';

export interface ValidateClinicalCatalogOptions {
  group?: string;
  calculator?: string;
  requireSourceVerified?: boolean;
  requireScenarioVerified?: boolean;
  releaseAttestation?: ReleaseEvidenceAttestation;
  caseRunner?: ValidationCaseRunner;
}

function error(code: string, message: string, calculatorId?: string): ReviewIssue {
  return { code, message, severity: 'error', ...(calculatorId === undefined ? {} : { calculatorId }) };
}

export async function validateClinicalCatalog(
  options: ValidateClinicalCatalogOptions = {},
): Promise<ValidationReport> {
  const catalog = loadValidationCatalog();
  const dossiers = loadValidationDossiers();
  const authorities = loadAuthorityRegistry();
  const specs = loadSpecs();
  const errors: ReviewIssue[] = [];
  const catalogIds = catalog.groups.flatMap((group) => group.calculatorIds);

  if (new Set(catalogIds).size !== catalogIds.length) {
    errors.push(error('catalog.duplicate_calculator', 'a calculator appears in more than one review group'));
  }
  for (const id of specs.keys()) {
    if (!dossiers.has(id)) errors.push(error('catalog.missing_dossier', `missing dossier for ${id}`, id));
    if (!catalogIds.includes(id)) errors.push(error('catalog.missing_enrollment', `${id} is not enrolled`, id));
  }
  for (const id of dossiers.keys()) {
    if (!specs.has(id)) errors.push(error('catalog.orphan_dossier', `dossier ${id} has no spec`, id));
  }
  for (const id of catalogIds) {
    if (!specs.has(id) || !dossiers.has(id)) {
      errors.push(error('catalog.orphan_enrollment', `enrolled calculator ${id} lacks a matching spec or dossier`, id));
    }
  }

  if (options.group !== undefined && options.calculator !== undefined) {
    throw new Error('choose either a validation group or one calculator, not both');
  }
  if (options.releaseAttestation !== undefined &&
      (options.group !== undefined || options.calculator !== undefined)) {
    throw new Error('release validation must cover the complete catalog');
  }
  const selectedIds = options.calculator !== undefined
    ? (catalogIds.includes(options.calculator) ? [options.calculator] : undefined)
    : options.group === undefined
      ? catalogIds
      : catalog.groups.find((group) => group.id === options.group)?.calculatorIds;
  if (selectedIds === undefined) {
    throw new Error(options.calculator === undefined
      ? `Unknown validation group '${options.group}'`
      : `Unknown calculator '${options.calculator}'`);
  }
  const requestedGate = options.releaseAttestation !== undefined
    ? 'release'
    : options.requireScenarioVerified
      ? 'scenario'
      : options.requireSourceVerified
        ? 'source'
        : 'integrity';
  if ((requestedGate === 'scenario' || requestedGate === 'release') && options.caseRunner === undefined) {
    throw new Error('scenario and release validation require a case runner');
  }

  const calculatorReports: CalculatorValidationReport[] = [];
  for (const id of selectedIds) {
    const original = dossiers.get(id);
    const spec = specs.get(id);
    if (original === undefined || spec === undefined) continue;
    const issues = validateDossierIntegrity(original, spec, catalog, authorities);
    const asset = clinicalDataAssetFor(id);
    if (asset !== undefined) {
      issues.push(...clinicalDataAssetProblems(asset, spec).map((problem) =>
        error(problem.code, problem.message, id)));
    }

    const caseResults = options.caseRunner === undefined
      ? new Map()
      : await executeValidationCases(original, options.caseRunner);
    const reviewState = deriveReviewStateWithIssues(original, caseResults, new Date(), issues);
    const gateFailed =
      (requestedGate === 'source' && !['source_verified', 'scenario_verified'].includes(reviewState.state)) ||
      (['scenario', 'release'].includes(requestedGate) && reviewState.state !== 'scenario_verified');
    if (gateFailed) errors.push(error('gate.not_met', `${requestedGate} gate not met: ${reviewState.state}`, id));
    calculatorReports.push({ calculatorId: id, reviewState, issues });
  }

  errors.push(...calculatorReports.flatMap((report) => report.issues));
  const selectedGroups = catalog.groups.filter((group) =>
    group.calculatorIds.every((id) => selectedIds.includes(id)));
  const groupReports = selectedGroups.map((group) =>
    deriveGroupReadiness(group.id, group.calculatorIds, calculatorReports));
  if (requestedGate === 'source') {
    for (const group of groupReports) {
      if (!['source_verified', 'scenario_verified'].includes(group.state)) {
        errors.push(error('group_gate.not_met', `source gate not met by group ${group.groupId}: ${group.state}`));
      }
    }
  } else if (requestedGate === 'scenario' || requestedGate === 'release') {
    for (const group of groupReports) {
      if (group.state !== 'scenario_verified') {
        errors.push(error('group_gate.not_met', `${requestedGate} gate not met by group ${group.groupId}: ${group.state}`));
      }
    }
  }
  if (options.releaseAttestation !== undefined) {
    const packageVersion = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
    const release = validateReleaseEvidenceAttestation(options.releaseAttestation, packageVersion);
    errors.push(...release.errors);
    const attested = new Set(options.releaseAttestation.calculatorIds);
    const expected = new Set(catalogIds);
    for (const id of expected) if (!attested.has(id)) errors.push(error('release.missing_calculator', `release attestation omits ${id}`, id));
    for (const id of attested) if (!expected.has(id)) errors.push(error('release.unknown_calculator', `release attestation includes unknown ${id}`, id));
    const requiredByCalculator = new Map<string, ReadonlyMap<string, string>>();
    const checkedAtByCalculator = new Map<string, ReadonlyMap<string, string>>();
    const reviewedAtByCalculator = new Map<string, ReadonlyMap<string, string>>();
    for (const id of catalogIds) {
      const dossier = dossiers.get(id);
      if (dossier === undefined) continue;
      const requiredSourceIds = new Set([
        ...dossier.authoritySourceIds,
        ...dossier.searchRecords.flatMap((record) => record.screenedCitations
          .filter((citation) => citation.disposition === 'included')
          .map((citation) => citation.citationId)),
      ]);
      const requiredSources = new Map<string, string>();
      const checkedSources = new Map<string, string>();
      for (const sourceId of requiredSourceIds) {
        const source = authorities.get(sourceId);
        if (source !== undefined) {
          requiredSources.set(sourceId, source.version);
          checkedSources.set(sourceId, source.checkedAt);
        }
      }
      requiredByCalculator.set(id, requiredSources);
      checkedAtByCalculator.set(id, checkedSources);
      reviewedAtByCalculator.set(id, new Map(dossier.claims.flatMap((claim) =>
        claim.reviewedAt === undefined ? [] : [[claim.id, claim.reviewedAt] as const])));
    }
    errors.push(...validateReleaseSourceVersions(options.releaseAttestation, requiredByCalculator));
    errors.push(...validateReleaseSourceCurrentness(options.releaseAttestation, checkedAtByCalculator));
    errors.push(...validateReleaseReviewCurrentness(options.releaseAttestation, reviewedAtByCalculator));
  }
  return { ok: errors.length === 0, requestedGate, calculatorReports, groupReports, errors, warnings: [] };
}
