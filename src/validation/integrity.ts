import type { CalcSpec } from '../engine/spec-schema.js';
import {
  allowedClaimKindsForKey,
  claimCoverageKeyExists,
  coverageMustBeExecutable,
  requiredCaseTags,
  requiredClinicalClaimKeys,
} from './coverage.js';
import { validateSearchRecord } from './search-policy.js';
import type {
  AuthoritySource,
  ReviewIssue,
  ValidationCatalog,
  ValidationCase,
  ValidationDossier,
} from './schema.js';

type Gate = NonNullable<ReviewIssue['gate']>;

const DAY_MS = 86_400_000;

function daysBetween(start: string, end: string): number {
  return (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / DAY_MS;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function warningMatches(expectedWarnings: readonly string[] | undefined, message: string): boolean {
  return (expectedWarnings ?? []).includes(message);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

function referenceSignature(testCase: ValidationCase): string {
  const successful = ['calculate', 'warn', 'omit'].includes(testCase.expectedBehavior);
  const interpretations = (successful ? (testCase.expectedInterpretations ?? []) : [])
    .map((entry) => canonicalValue(entry))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify(canonicalValue({
    inputs: testCase.inputs,
    expected: successful ? testCase.expected : {},
    expectedBehavior: testCase.expectedBehavior,
    expectedWarnings: testCase.expectedBehavior === 'warn'
      ? [...(testCase.expectedWarnings ?? [])].sort()
      : [],
    expectedInterpretations: interpretations,
    expectedError: ['reject', 'clarify'].includes(testCase.expectedBehavior)
      ? testCase.expectedError
      : undefined,
    omittedOutputs: testCase.expectedBehavior === 'omit'
      ? [...(testCase.omittedOutputs ?? [])].sort()
      : [],
  }));
}

export function independentReferenceCaseCount(dossier: ValidationDossier): number {
  return new Set(dossier.cases
    .filter((testCase) => testCase.kind === 'reference')
    .map(referenceSignature)).size;
}

function constraintFields(constraint: NonNullable<CalcSpec['constraints']>[number]): string[] {
  switch (constraint.kind) {
    case 'atLeastOne': return [constraint.fields.join(' | ')];
    case 'requiredWhen': return [constraint.required.join(' | ')];
    case 'requireValueWhen':
    case 'forbidValueWhen': return [constraint.target];
    case 'requireAtLeastValuesWhen': return [constraint.field];
    case 'forbidPresentWhen': return constraint.forbidden;
    case 'compare': return [constraint.left];
  }
}

function witnessProves(testCase: ValidationCase, key: string, spec: CalcSpec): boolean {
  const behavior = testCase.expectedBehavior;
  const successful = ['calculate', 'warn', 'omit'].includes(behavior);
  if (key.startsWith('formula:') || key.startsWith('coefficient:')) {
    return successful && spec.primaryOutputs.some((output) => Object.hasOwn(testCase.expected, output));
  }
  if (key.startsWith('output:')) {
    const output = key.slice('output:'.length);
    return Object.hasOwn(testCase.expected, output) || (testCase.omittedOutputs ?? []).includes(output);
  }
  if (key.startsWith('warning:')) {
    const warning = spec.warnings?.[Number(key.slice('warning:'.length))];
    return behavior === 'warn' && warning !== undefined && warningMatches(testCase.expectedWarnings, warning.message);
  }
  if (key.startsWith('cap:')) {
    const adjustmentId = key.slice('cap:'.length);
    const warning = spec.warnings?.find((entry) => entry.adjustmentId === adjustmentId);
    return behavior === 'warn' && warning !== undefined && warningMatches(testCase.expectedWarnings, warning.message);
  }
  if (key.startsWith('band:')) {
    const parts = key.split(':');
    const output = parts[1] === 'calculator' ? undefined : parts[1];
    const index = Number(parts[2]);
    const band = output === undefined
      ? spec.interpretationBands?.[index]
      : spec.outputs[output]?.interpretationBands?.[index];
    const expectedOutput = output ?? spec.primaryOutputs[0];
    return band !== undefined && expectedOutput !== undefined &&
      (testCase.expectedInterpretations ?? []).some((entry) =>
        entry.output === expectedOutput && entry.code === band.code && entry.kind === band.kind &&
        entry.label === band.label && entry.severity === band.severity);
  }
  if (key.startsWith('cutoff:')) {
    const code = key.slice('cutoff:'.length);
    const candidates = [
      ...(spec.interpretationBands ?? []).map((band) => ({ output: spec.primaryOutputs[0], band })),
      ...Object.entries(spec.outputs).flatMap(([output, definition]) =>
        (definition.interpretationBands ?? []).map((band) => ({ output, band }))),
    ];
    const declared = candidates.find((candidate) => candidate.band.code === code);
    return declared?.output !== undefined && (testCase.expectedInterpretations ?? []).some((entry) =>
      entry.output === declared.output && entry.code === declared.band.code &&
      entry.kind === declared.band.kind && entry.label === declared.band.label &&
      entry.severity === declared.band.severity);
  }
  if (key.startsWith('constraint:')) {
    const constraint = spec.constraints?.[Number(key.slice('constraint:'.length))];
    return constraint !== undefined && ['reject', 'clarify'].includes(behavior) &&
      testCase.expectedError?.code === 'CONSTRAINT_FAILED' &&
      constraintFields(constraint).includes(testCase.expectedError.field) &&
      testCase.expectedError.messageIncludes === constraint.message;
  }
  if (key === 'applicability:purpose') return testCase.kind === 'agent' && successful;
  if (key === 'applicability:exclusions') return testCase.kind === 'agent' && behavior !== 'calculate';
  if (key === 'interpretation:prompt') return testCase.kind === 'agent' && successful;
  if (key.startsWith('unit:')) {
    const input = key.slice('unit:'.length);
    const supplied = testCase.inputs[input];
    return successful && typeof supplied === 'object' && supplied !== null && typeof (supplied as { unit?: unknown }).unit === 'string';
  }
  if (key.startsWith('default:')) return successful && !(key.slice('default:'.length) in testCase.inputs);
  if (key.endsWith(':hard_limits')) {
    const input = key.split(':')[1];
    return testCase.kind === 'edge' && behavior === 'reject' && testCase.expectedError?.field === input;
  }
  if (key.endsWith(':plausibility')) return testCase.kind === 'edge' && behavior === 'warn';
  if (key.endsWith(':aliases')) {
    const input = key.split(':')[1] ?? '';
    const aliases = spec.inputs[input]?.aliases ?? [];
    return successful && !(input in testCase.inputs) && aliases.some((alias) => alias in testCase.inputs);
  }
  if (key.endsWith(':options')) {
    const input = key.split(':')[1] ?? '';
    const value = testCase.inputs[input];
    const declared = spec.inputs[input];
    return successful && declared?.kind === 'enum' && declared.enumValues.some((option) => option.value === value);
  }
  if (/^input:[^:]+$/.test(key)) {
    const input = key.split(':')[1] ?? '';
    return successful || (['reject', 'clarify'].includes(behavior) && testCase.expectedError?.field === input);
  }
  if (key.startsWith('interpretation:')) return (testCase.expectedInterpretations?.length ?? 0) > 0;
  return false;
}

function tagCaseProves(tag: string, testCase: ValidationCase, spec: CalcSpec): boolean {
  const witnesses = testCase.witnesses.filter((key) => witnessProves(testCase, key, spec));
  if (tag === 'required-inputs') {
    return ['reject', 'clarify'].includes(testCase.expectedBehavior) && witnesses.some((key) => /^input:[^:]+$/.test(key));
  }
  if (tag === 'hard-limits') return testCase.kind === 'edge' && witnesses.some((key) => key.endsWith(':hard_limits'));
  if (tag === 'plausibility') return testCase.kind === 'edge' && witnesses.some((key) => key.endsWith(':plausibility'));
  if (tag === 'defaults') return witnesses.some((key) => key.startsWith('default:'));
  if (tag === 'aliases') return witnesses.some((key) => key.endsWith(':aliases'));
  if (tag === 'unit-equivalence') return witnesses.some((key) => key.startsWith('unit:'));
  if (tag === 'interpretation-boundaries') return testCase.kind === 'edge' && witnesses.some((key) => key.startsWith('band:') || key.startsWith('cutoff:'));
  if (tag === 'constraints') return testCase.kind === 'edge' && witnesses.some((key) => key.startsWith('constraint:'));
  if (tag === 'conditional-output') return witnesses.some((key) => key.startsWith('output:') || key === 'interpretation:prompt');
  if (tag === 'agent-applicability') return testCase.kind === 'agent' && witnesses.some((key) => key.startsWith('applicability:'));
  if (/^calculator:[^:]+:core$/.test(tag)) return witnesses.includes('formula:implementation');
  return false;
}

function dossierReviewCadenceDays(dossier: ValidationDossier, bundleRoles: readonly string[]): number {
  if (dossier.reviewGroup === 'policy_versioned' || bundleRoles.includes('approved_label')) return 90;
  if (dossier.reviewGroup === 'interpreter_conditional') return 180;
  return 365;
}

function issue(
  code: string,
  message: string,
  calculatorId: string,
  gate: Gate,
  path?: string,
): ReviewIssue {
  return { code, message, severity: 'error', gate, calculatorId, ...(path === undefined ? {} : { path }) };
}

export function validateDossierIntegrity(
  dossier: ValidationDossier,
  spec: CalcSpec,
  catalog: ValidationCatalog,
  authorities: ReadonlyMap<string, AuthoritySource>,
): ReviewIssue[] {
  const id = dossier.calculatorId;
  const issues: ReviewIssue[] = [];
  const group = catalog.groups.find((entry) => entry.calculatorIds.includes(id));
  const bundle = catalog.calculatorSourcePolicyOverrides[id] ??
    (group === undefined ? undefined : catalog.sourcePolicies[group.id]);
  const reviewCadenceDays = dossierReviewCadenceDays(dossier, bundle?.roles ?? []);

  if (dossier.specVersion !== spec.version) issues.push(issue('dossier.version_mismatch', 'dossier specVersion does not match spec', id, 'integrity'));
  if (group?.id !== dossier.reviewGroup) issues.push(issue('dossier.group_mismatch', 'dossier reviewGroup does not match catalog', id, 'integrity'));
  if (bundle === undefined) issues.push(issue('dossier.source_policy', 'calculator has no source policy', id, 'integrity'));

  const selectedAuthorities = new Map<string, AuthoritySource>();
  const today = todayUtc();
  for (const sourceId of dossier.authoritySourceIds) {
    const source = authorities.get(sourceId);
    if (source === undefined) issues.push(issue('source.unknown_authority', `unknown authority source ${sourceId}`, id, 'source'));
    else {
      selectedAuthorities.set(sourceId, source);
      if (source.checkedAt > today) {
        issues.push(issue('source.future_checked_at', `authority ${sourceId} has a future checkedAt date`, id, 'source', sourceId));
      }
      if (daysBetween(source.checkedAt, source.reviewBy) > reviewCadenceDays) {
        issues.push(issue('source.review_cadence', `authority ${sourceId} exceeds its review cadence`, id, 'source', sourceId));
      }
    }
  }

  const verifiedSearchRoles = new Set<string>();
  const verifiedSearchAuthorities = new Map<string, Set<string>>();
  for (const record of dossier.searchRecords) {
    if (record.calculatorId !== id) issues.push(issue('search.calculator_mismatch', `search ${record.id} belongs to ${record.calculatorId}`, id, 'source', record.id));
    if (record.model !== dossier.clinicalModel) issues.push(issue('search.model_mismatch', `search ${record.id} does not match clinicalModel`, id, 'source', record.id));
    if (record.variant !== dossier.variant) issues.push(issue('search.variant_mismatch', `search ${record.id} does not match variant`, id, 'source', record.id));
    if (record.searchedAt > today) {
      issues.push(issue('search.future_date', `search ${record.id} is future-dated`, id, 'source', record.id));
    }
    if (record.qualityReview.reviewedAt > today) {
      issues.push(issue('search.future_review', `search QA ${record.id} is future-dated`, id, 'source', record.id));
    }
    if (daysBetween(record.searchedAt, record.reviewBy) > reviewCadenceDays) {
      issues.push(issue('search.review_cadence', `search ${record.id} exceeds the ${reviewCadenceDays}-day review cadence`, id, 'source', record.id));
    }
    if (bundle !== undefined) {
      issues.push(...validateSearchRecord(record, bundle).issues.map((entry) => ({ ...entry, gate: 'source' as const, calculatorId: id })));
    }
    for (const searchSource of record.sources) {
      if (searchSource.searchedAt > today) {
        issues.push(issue('search.source_future_date', `search source ${searchSource.id} is future-dated`, id, 'source', record.id));
      }
      if (searchSource.coverageFrom !== undefined && searchSource.coverageFrom > today) {
        issues.push(issue('search.future_coverage', `search source ${searchSource.id} has future coverage`, id, 'source', record.id));
      }
      if (searchSource.coverageTo > today) {
        issues.push(issue('search.future_coverage', `search source ${searchSource.id} has future coverage`, id, 'source', record.id));
      }
      if (searchSource.coverageFrom !== undefined && searchSource.coverageFrom > searchSource.coverageTo) {
        issues.push(issue('search.coverage_order', `search source ${searchSource.id} coverageFrom follows coverageTo`, id, 'source', record.id));
      }
      const authority = authorities.get(searchSource.authorityId);
      if (authority === undefined) {
        issues.push(issue('search.unknown_authority', `search source ${searchSource.id} references unknown authority ${searchSource.authorityId}`, id, 'source', record.id));
      } else {
        if (authority.sourceRole !== searchSource.sourceRole) {
          issues.push(issue('search.source_role_mismatch', `search source ${searchSource.id} role does not match authority registry`, id, 'source', record.id));
        }
        if (!dossier.authoritySourceIds.includes(authority.id)) {
          issues.push(issue('search.unenrolled_authority', `search authority ${authority.id} is not enrolled in the dossier`, id, 'source', record.id));
        }
        if (searchSource.sourceRole !== 'bibliographic_database' && authority.discoveryOnly) {
          issues.push(issue('search.discovery_only_role', `discovery-only source ${authority.id} cannot satisfy ${searchSource.sourceRole}`, id, 'source', record.id));
        } else if (authority.sourceRole === searchSource.sourceRole && dossier.authoritySourceIds.includes(authority.id)) {
          verifiedSearchRoles.add(authority.sourceRole);
          const roleAuthorities = verifiedSearchAuthorities.get(authority.sourceRole) ?? new Set<string>();
          roleAuthorities.add(authority.id);
          verifiedSearchAuthorities.set(authority.sourceRole, roleAuthorities);
        }
      }
    }
  }
  if (bundle !== undefined && dossier.searchRecords.length > 0) {
    for (const role of bundle.roles) {
      if (!verifiedSearchRoles.has(role)) issues.push(issue('source.required_authority_role', `search evidence omits a registry-verified source for required role ${role}`, id, 'source'));
    }
    if ((verifiedSearchAuthorities.get('external_validation')?.size ?? 0) < bundle.minimumExternalValidations) {
      issues.push(issue('source.external_validation_count', `search evidence has fewer than ${bundle.minimumExternalValidations} registry-verified external validations`, id, 'source'));
    }
  }
  const includedCitations = new Set(dossier.searchRecords.flatMap((record) =>
    record.screenedCitations.filter((citation) => citation.disposition === 'included').map((citation) => citation.citationId)));
  for (const citationId of includedCitations) {
    const citation = authorities.get(citationId);
    if (citation === undefined || citation.discoveryOnly || !dossier.authoritySourceIds.includes(citationId)) {
      issues.push(issue('source.unregistered_citation', `included citation ${citationId} must be a non-discovery authority-registry source enrolled in the dossier`, id, 'source'));
    }
  }
  const citableAuthorities = new Set([...selectedAuthorities]
    .filter(([, source]) => !source.discoveryOnly)
    .map(([sourceId]) => sourceId));
  const knownClaimSources = citableAuthorities;

  const requiredClaims = requiredClinicalClaimKeys(spec);
  const coverageCounts = new Map<string, number>();
  const clinicalClaims = dossier.claims.filter((claim) => claim.scope === 'clinical');
  for (const claim of clinicalClaims) {
    const key = claim.covers[0] ?? '';
    coverageCounts.set(key, (coverageCounts.get(key) ?? 0) + 1);
    const allowedKinds = allowedClaimKindsForKey(key);
    if (!claimCoverageKeyExists(spec, key, requiredClaims)) issues.push(issue('claim.unknown_coverage', `claim covers unknown spec surface ${key}`, id, 'source', key));
    else if (!allowedKinds.has(claim.kind)) issues.push(issue('claim.kind_mismatch', `claim ${claim.id} kind ${claim.kind} does not match ${key}`, id, 'source', claim.id));
    if (coverageMustBeExecutable(key) && !claim.executable) {
      issues.push(issue('claim.execution_required', `claim ${claim.id} covers runtime-verifiable surface ${key} and cannot opt out of scenarios`, id, 'scenario', claim.id));
    }
    if (claim.reviewedAt !== undefined && claim.reviewedAt > today) {
      issues.push(issue('claim.future_review', `claim ${claim.id} is future-dated`, id, 'source', claim.id));
    }
    if (claim.reviewedAt !== undefined && claim.reviewBy !== undefined && daysBetween(claim.reviewedAt, claim.reviewBy) > reviewCadenceDays) {
      issues.push(issue('claim.review_cadence', `claim ${claim.id} exceeds the ${reviewCadenceDays}-day review cadence`, id, 'source', claim.id));
    }
  }
  if (clinicalClaims.length > 0) {
    for (const key of requiredClaims) {
      const count = coverageCounts.get(key) ?? 0;
      if (count === 0) issues.push(issue('claim.missing_coverage', `no claim covers ${key}`, id, 'source', key));
    }
    for (const [key, count] of coverageCounts) {
      if (count > 1) issues.push(issue('claim.duplicate_coverage', `multiple claims cover ${key}`, id, 'source', key));
    }
  }

  const claims = new Map(dossier.claims.map((claim) => [claim.id, claim]));
  const cases = new Map(dossier.cases.map((testCase) => [testCase.id, testCase]));
  if ((dossier.cases.length > 0 || dossier.claims.some((claim) => claim.executable)) &&
      independentReferenceCaseCount(dossier) < 3) {
    issues.push(issue(
      'case.insufficient_reference_cases',
      'scenario verification requires at least three source-linked independent reference cases',
      id,
      'scenario',
      'cases',
    ));
  }
  for (const claim of dossier.claims) {
    for (const sourceId of claim.sourceIds) {
      if (!knownClaimSources.has(sourceId)) issues.push(issue('claim.unknown_source', `claim ${claim.id} links unknown or discovery-only source ${sourceId}`, id, 'source', claim.id));
    }
    for (const locator of claim.locators) {
      if (!claim.sourceIds.includes(locator.sourceId)) issues.push(issue('claim.locator_source', `claim ${claim.id} locator is not in sourceIds`, id, 'source', claim.id));
    }
    for (const caseId of claim.scenarioIds) {
      const testCase = cases.get(caseId);
      if (testCase === undefined) issues.push(issue('claim.unknown_scenario', `claim ${claim.id} links unknown case ${caseId}`, id, 'scenario', claim.id));
      else if (!testCase.claimIds.includes(claim.id)) issues.push(issue('claim.scenario_backlink', `case ${caseId} does not link back to claim ${claim.id}`, id, 'scenario', claim.id));
    }
  }

  for (const testCase of dossier.cases) {
    const linkedClaims = testCase.claimIds.map((claimId) => claims.get(claimId));
    for (const [index, claim] of linkedClaims.entries()) {
      const claimId = testCase.claimIds[index] ?? '';
      if (claim === undefined) {
        issues.push(issue('case.unknown_claim', `case ${testCase.id} links unknown claim ${claimId}`, id, 'scenario', testCase.id));
        continue;
      }
      if (claim.executable && !claim.scenarioIds.includes(testCase.id)) {
        issues.push(issue('case.claim_backlink', `claim ${claim.id} does not link back to case ${testCase.id}`, id, 'scenario', testCase.id));
      }
      if (!testCase.sourceIds.some((sourceId) => claim.sourceIds.includes(sourceId))) {
        issues.push(issue('case.claim_source', `case ${testCase.id} has no source shared with claim ${claim.id}`, id, 'scenario', testCase.id));
      }
    }
    const linkedSources = new Set(linkedClaims.flatMap((claim) => claim?.sourceIds ?? []));
    for (const sourceId of testCase.sourceIds) {
      if (!linkedSources.has(sourceId)) issues.push(issue('case.unlinked_source', `case ${testCase.id} source ${sourceId} supports none of its claims`, id, 'scenario', testCase.id));
    }
    const linkedCoverage = new Set(linkedClaims.flatMap((claim) => claim?.covers ?? []));
    for (const witness of testCase.witnesses) {
      if (!linkedCoverage.has(witness)) issues.push(issue('case.unlinked_witness', `case ${testCase.id} witness ${witness} is not covered by a linked claim`, id, 'scenario', testCase.id));
      else if (!witnessProves(testCase, witness, spec)) issues.push(issue('case.unproven_witness', `case ${testCase.id} does not assert the behavior claimed by witness ${witness}`, id, 'scenario', testCase.id));
    }
    for (const output of [...Object.keys(testCase.expected), ...(testCase.omittedOutputs ?? [])]) {
      if (!(output in spec.outputs)) issues.push(issue('case.unknown_output', `case ${testCase.id} references undeclared output ${output}`, id, 'scenario', testCase.id));
    }
    for (const interpretation of testCase.expectedInterpretations ?? []) {
      if (!(interpretation.output in spec.outputs)) issues.push(issue('case.unknown_interpretation_output', `case ${testCase.id} references undeclared interpretation output ${interpretation.output}`, id, 'scenario', testCase.id));
    }
  }

  for (const claim of dossier.claims.filter((entry) => entry.executable)) {
    const key = claim.covers[0] ?? '';
    const witnessed = claim.scenarioIds.some((caseId) => {
      const testCase = cases.get(caseId);
      return testCase !== undefined && testCase.witnesses.includes(key) && witnessProves(testCase, key, spec);
    });
    if (!witnessed) issues.push(issue('claim.unwitnessed_coverage', `executable claim ${claim.id} has no linked case witnessing ${key}`, id, 'scenario', claim.id));
  }

  if (dossier.cases.length > 0 || dossier.claims.some((claim) => claim.executable)) {
    for (const tag of requiredCaseTags(spec)) {
      let matching = dossier.cases.some((testCase) => testCase.tags.includes(tag) && tagCaseProves(tag, testCase, spec));
      if (tag === 'unit-equivalence') {
        const unitsByWitness = new Map<string, Set<string>>();
        for (const testCase of dossier.cases.filter((entry) => entry.tags.includes(tag))) {
          for (const witness of testCase.witnesses.filter((key) => key.startsWith('unit:') && witnessProves(testCase, key, spec))) {
            const input = witness.slice('unit:'.length);
            const unit = (testCase.inputs[input] as { unit?: unknown } | undefined)?.unit;
            if (typeof unit !== 'string') continue;
            const units = unitsByWitness.get(witness) ?? new Set<string>();
            units.add(unit);
            unitsByWitness.set(witness, units);
          }
        }
        matching = [...unitsByWitness.values()].some((units) => units.size >= 2);
      }
      if (!matching) issues.push(issue('case.missing_tag', `missing required case tag ${tag} with a relevant claim witness`, id, 'scenario', String(tag)));
    }
  }
  return issues;
}
