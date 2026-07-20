import type { CalcSpec } from '../engine/spec-schema.js';
import { loadValidationCatalog } from './load-validation.js';
import type {
  LiteratureSearchRecord,
  RequiredSourceBundle,
  ReviewIssue,
} from './schema.js';

export interface SearchValidationResult {
  ok: boolean;
  issues: ReviewIssue[];
}

export function requiredSourceBundle(spec: CalcSpec): RequiredSourceBundle {
  const catalog = loadValidationCatalog();
  const override = catalog.calculatorSourcePolicyOverrides[spec.id];
  if (override !== undefined) return override;
  const group = catalog.groups.find((entry) => entry.calculatorIds.includes(spec.id));
  if (group === undefined) throw new Error(`Calculator '${spec.id}' has no validation source policy`);
  return catalog.sourcePolicies[group.id];
}

function issue(code: string, message: string, path?: string): ReviewIssue {
  return { code, message, severity: 'error', ...(path === undefined ? {} : { path }) };
}

export function validateSearchRecord(
  record: LiteratureSearchRecord,
  bundle: RequiredSourceBundle,
): SearchValidationResult {
  const issues: ReviewIssue[] = [];
  const counts = record.accounting;
  const sourceRetrieved = record.sources.reduce((sum, source) => sum + source.recordsRetrieved, 0);
  if (sourceRetrieved !== counts.retrieved) {
    issues.push(issue('search.accounting.retrieved', 'retrieved count must equal the sum of source results', 'accounting.retrieved'));
  }
  if (counts.deduplicated > counts.retrieved) {
    issues.push(issue('search.accounting.deduplicated', 'deduplicated count cannot exceed retrieved count', 'accounting.deduplicated'));
  }
  if (counts.screened !== counts.deduplicated) {
    issues.push(issue('search.accounting.screened', 'every deduplicated record must be screened', 'accounting.screened'));
  }
  if (counts.fullTextAssessed > counts.screened) {
    issues.push(issue('search.accounting.full_text', 'full-text count cannot exceed screened count', 'accounting.fullTextAssessed'));
  }
  if (counts.excluded + counts.included !== counts.fullTextAssessed) {
    issues.push(issue('search.accounting.disposition', 'included plus excluded must equal full-text assessed', 'accounting'));
  }
  const fullText = record.screenedCitations.filter((citation) => citation.fullTextAssessed);
  if (record.screenedCitations.length !== counts.screened) {
    issues.push(issue('search.citations.screened', 'citation ledger must represent every screened record', 'screenedCitations'));
  }
  if (fullText.length !== counts.fullTextAssessed) {
    issues.push(issue('search.citations.full_text', 'screened citation ledger must match full-text accounting', 'screenedCitations'));
  }
  if (fullText.filter((citation) => citation.disposition === 'included').length !== counts.included ||
      fullText.filter((citation) => citation.disposition === 'excluded').length !== counts.excluded) {
    issues.push(issue('search.citations.disposition', 'full-text citation dispositions must match included/excluded accounting', 'screenedCitations'));
  }
  if (record.screenedCitations.some((citation) => !citation.fullTextAssessed && citation.disposition !== 'excluded')) {
    issues.push(issue('search.citations.pre_full_text', 'records not assessed in full text cannot be included', 'screenedCitations'));
  }
  if (!record.qualityReview.resolved) {
    issues.push(issue('search.qa.unresolved', 'second-specialist PRESS-derived review must be resolved', 'qualityReview'));
  }
  const medline = record.sources.find((source) => source.id === record.qualityReview.initialMedlineSourceId);
  if (medline === undefined || medline.sourceRole !== 'bibliographic_database' ||
      !/medline|pubmed/i.test(`${medline.database} ${medline.site}`)) {
    issues.push(issue('search.qa.medline_source', 'quality review must reference a searched MEDLINE source', 'qualityReview.initialMedlineSourceId'));
  }
  if (medline !== undefined && medline.reviewer === record.qualityReview.reviewer) {
    issues.push(issue('search.qa.independence', 'search strategy reviewer must be distinct from the original searcher', 'qualityReview.reviewer'));
  }
  if (!record.citationChasing.backward || !record.citationChasing.forward) {
    issues.push(issue('search.citation_chasing', 'both backward and forward citation chasing are required', 'citationChasing'));
  }
  for (const [name, checked] of Object.entries(record.checks)) {
    if (!checked) issues.push(issue(`search.check.${name}`, `${name} check is required`, `checks.${name}`));
  }
  const roles = record.sources.map((source) => source.sourceRole);
  for (const role of bundle.roles) {
    if (!roles.includes(role)) issues.push(issue('search.source_role', `search omitted required source role ${role}`, 'sources'));
  }
  if (roles.filter((role) => role === 'external_validation').length < bundle.minimumExternalValidations) {
    issues.push(issue('search.external_validation', 'search omitted required independent external validation coverage', 'sources'));
  }
  if (bundle.controllingAuthorityRequired &&
      !roles.includes('controlling_authority') &&
      !roles.includes('approved_label')) {
    issues.push(issue('search.controlling_authority', 'search omitted the controlling authority or approved regulator label', 'sources'));
  }
  return { ok: issues.length === 0, issues };
}
