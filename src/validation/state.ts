import { loadSpec } from '../engine/load-specs.js';
import { independentReferenceCaseCount, validateDossierIntegrity } from './integrity.js';
import { loadAuthorityRegistry, loadValidationCatalog } from './load-validation.js';
import type {
  CalculatorValidationReport,
  CaseExecutionResult,
  ReviewGroup,
  ReviewGroupValidationReport,
  ReviewIssue,
  ReviewState,
  ValidationDossier,
} from './schema.js';

const REVIEW_STATES = [
  'pending', 'blocked', 'stale', 'search_complete', 'source_verified', 'scenario_verified',
] as const;

export function deriveGroupReadiness(
  groupId: ReviewGroup,
  calculatorIds: readonly string[],
  reports: readonly CalculatorValidationReport[],
): ReviewGroupValidationReport {
  const reportsById = new Map(reports.map((report) => [report.calculatorId, report]));
  const missingCalculatorIds = calculatorIds.filter((id) => !reportsById.has(id));
  const states = calculatorIds.flatMap((id) => {
    const report = reportsById.get(id);
    return report === undefined ? [] : [report.reviewState.state];
  });
  const memberStateCounts = Object.fromEntries(REVIEW_STATES.map((state) => [
    state,
    states.filter((candidate) => candidate === state).length,
  ])) as Record<(typeof REVIEW_STATES)[number], number>;

  let state: ReviewGroupValidationReport['state'] = 'pending';
  if (memberStateCounts.blocked > 0) state = 'blocked';
  else if (memberStateCounts.stale > 0) state = 'stale';
  else if (missingCalculatorIds.length === 0 && memberStateCounts.scenario_verified === calculatorIds.length) {
    state = 'scenario_verified';
  } else if (missingCalculatorIds.length === 0 &&
      memberStateCounts.source_verified + memberStateCounts.scenario_verified === calculatorIds.length) {
    state = 'source_verified';
  } else if (missingCalculatorIds.length === 0 &&
      memberStateCounts.search_complete + memberStateCounts.source_verified +
      memberStateCounts.scenario_verified === calculatorIds.length) {
    state = 'search_complete';
  }

  return {
    groupId,
    state,
    calculatorIds: [...calculatorIds],
    missingCalculatorIds,
    memberStateCounts,
  };
}

function issue(code: string, message: string, calculatorId: string): ReviewIssue {
  return { code, message, severity: 'error', calculatorId };
}

function caseResultPassed(result: CaseExecutionResult | undefined): boolean {
  return result?.status === 'passed' &&
    result.enginePassed &&
    result.fullMcpPassed &&
    result.compactMcpPassed &&
    result.parityPassed &&
    result.issues.length === 0;
}

export function deriveReviewState(
  dossier: ValidationDossier,
  caseResults: ReadonlyMap<string, CaseExecutionResult>,
  now: Date,
): ReviewState {
  let derivedIssues: ReviewIssue[];
  try {
    derivedIssues = validateDossierIntegrity(
      dossier,
      loadSpec(dossier.calculatorId),
      loadValidationCatalog(),
      loadAuthorityRegistry(),
    );
  } catch (error) {
    derivedIssues = [{
      code: 'dossier.integrity_unavailable',
      message: error instanceof Error ? error.message : String(error),
      severity: 'error',
      gate: 'integrity',
      calculatorId: dossier.calculatorId,
    }];
  }
  return deriveReviewStateWithIssues(dossier, caseResults, now, derivedIssues);
}

export function deriveReviewStateWithIssues(
  dossier: ValidationDossier,
  caseResults: ReadonlyMap<string, CaseExecutionResult>,
  now: Date,
  derivedIssues: readonly ReviewIssue[],
): ReviewState {
  const blockers = [...dossier.explicitBlockers];
  const clinicalClaims = dossier.claims.filter((claim) => claim.scope === 'clinical');
  for (const claim of clinicalClaims) {
    if (['conflicted', 'unsupported', 'superseded'].includes(claim.status)) {
      blockers.push(issue('claim.blocked', `claim ${claim.id} is ${claim.status}`, dossier.calculatorId));
    }
  }
  for (const result of caseResults.values()) {
    if (!caseResultPassed(result)) {
      blockers.push(...result.issues);
      if (result.issues.length === 0) blockers.push(issue('case.failed', `case ${result.caseId} failed`, dossier.calculatorId));
    }
  }
  const dossierCaseIds = new Set(dossier.cases.map((testCase) => testCase.id));
  for (const [key, result] of caseResults) {
    if (!dossierCaseIds.has(key) || result.caseId !== key) {
      blockers.push(issue('case.result_identity', `case result ${key} does not match an enrolled dossier case`, dossier.calculatorId));
    }
  }

  const claimsSupported = clinicalClaims.filter((claim) =>
    ['supported', 'variant_specific'].includes(claim.status) &&
    claim.sourceIds.length > 0 && claim.locators.length > 0).length;
  const executable = clinicalClaims.filter((claim) => claim.executable);
  const passedCases = dossier.cases.filter((testCase) => {
    const result = caseResults.get(testCase.id);
    return result?.caseId === testCase.id && caseResultPassed(result);
  }).length;
  const witnessedExecutableClaims = executable.filter((claim) =>
    claim.scenarioIds.some((id) => {
      const result = caseResults.get(id);
      return result?.caseId === id && caseResultPassed(result);
    })).length;
  const counts = {
    claimsTotal: clinicalClaims.length,
    claimsSupported,
    requiredCases: dossier.cases.length,
    passedCases,
    executableClaims: executable.length,
    witnessedExecutableClaims,
  };

  const derivedErrors = derivedIssues.filter((entry) => entry.severity === 'error');
  const sourceErrors = derivedErrors.filter((entry) => entry.gate === 'integrity' || entry.gate === 'source' || entry.gate === undefined);
  const scenarioErrors = derivedErrors.filter((entry) => entry.gate === 'scenario');
  blockers.push(...sourceErrors, ...scenarioErrors);
  const searchesComplete = dossier.searchRecords.length > 0 && !sourceErrors.some((entry) => entry.code.startsWith('search.'));
  const sourceComplete = searchesComplete && sourceErrors.length === 0 && clinicalClaims.length > 0 && claimsSupported === clinicalClaims.length;
  const scenarioComplete = sourceComplete && independentReferenceCaseCount(dossier) >= 3 &&
    passedCases === dossier.cases.length &&
    witnessedExecutableClaims === executable.length && scenarioErrors.length === 0;
  const authorityRegistry = sourceComplete ? loadAuthorityRegistry() : new Map();
  const currentDate = now.toISOString().slice(0, 10);
  const staleSourceIds = sourceComplete ? [
    ...dossier.searchRecords.filter((record) => record.reviewBy < currentDate).map((record) => record.id),
    ...clinicalClaims.filter((claim) => claim.reviewBy !== undefined && claim.reviewBy < currentDate).map((claim) => claim.id),
    ...dossier.authoritySourceIds.filter((sourceId) => {
      const source = authorityRegistry.get(sourceId);
      return source !== undefined && source.reviewBy < currentDate;
    }),
  ] : [];

  let state: ReviewState['state'] = 'pending';
  if (blockers.length > 0) state = 'blocked';
  else if (staleSourceIds.length > 0) state = 'stale';
  else if (scenarioComplete) state = 'scenario_verified';
  else if (sourceComplete) state = 'source_verified';
  else if (searchesComplete) state = 'search_complete';

  return {
    state,
    derivedAt: now.toISOString(),
    blockers,
    staleSourceIds,
    counts,
  };
}
