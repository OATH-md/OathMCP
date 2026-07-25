import type {
  AuthoritySource,
  ReleaseEvidenceAttestation,
  ValidationCatalog,
  ValidationDossier,
} from './schema.js';

export interface ReleaseRequirements {
  calculatorIds: string[];
  sourceVersions: Record<string, string>;
  requiredByCalculator: Map<string, ReadonlyMap<string, string>>;
  checkedAtByCalculator: Map<string, ReadonlyMap<string, string>>;
  reviewedAtByCalculator: Map<string, ReadonlyMap<string, string>>;
  latestSourceCheckedAt: string;
  latestClaimReviewedAt: string;
}

function latest(values: readonly string[]): string {
  return values.reduce((current, value) => value > current ? value : current, '0000-00-00');
}

/**
 * Derive the complete, deterministic evidence inventory for a release.
 *
 * Review dates, reviewer identity, currentness confirmation, and unresolved
 * changes remain explicit release decisions. This function only collects the
 * catalog and source-version facts already recorded in the repository.
 */
export function deriveReleaseRequirements(
  catalog: ValidationCatalog,
  dossiers: ReadonlyMap<string, ValidationDossier>,
  authorities: ReadonlyMap<string, AuthoritySource>,
): ReleaseRequirements {
  const calculatorIds = catalog.groups.flatMap((group) => group.calculatorIds);
  const requiredByCalculator = new Map<string, ReadonlyMap<string, string>>();
  const checkedAtByCalculator = new Map<string, ReadonlyMap<string, string>>();
  const reviewedAtByCalculator = new Map<string, ReadonlyMap<string, string>>();
  const sourceVersions = new Map<string, string>();

  for (const id of calculatorIds) {
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
    for (const sourceId of [...requiredSourceIds].sort()) {
      const source = authorities.get(sourceId);
      if (source === undefined) continue;
      requiredSources.set(sourceId, source.version);
      checkedSources.set(sourceId, source.checkedAt);
      const existing = sourceVersions.get(sourceId);
      if (existing !== undefined && existing !== source.version) {
        throw new Error(`authority ${sourceId} has conflicting release versions`);
      }
      sourceVersions.set(sourceId, source.version);
    }
    requiredByCalculator.set(id, requiredSources);
    checkedAtByCalculator.set(id, checkedSources);
    reviewedAtByCalculator.set(id, new Map(dossier.claims.flatMap((claim) =>
      claim.reviewedAt === undefined ? [] : [[claim.id, claim.reviewedAt] as const])));
  }

  return {
    calculatorIds,
    sourceVersions: Object.fromEntries([...sourceVersions].sort(([left], [right]) => left.localeCompare(right))),
    requiredByCalculator,
    checkedAtByCalculator,
    reviewedAtByCalculator,
    latestSourceCheckedAt: latest([...checkedAtByCalculator.values()].flatMap((sources) => [...sources.values()])),
    latestClaimReviewedAt: latest([...reviewedAtByCalculator.values()].flatMap((claims) => [...claims.values()])),
  };
}

export function releaseAttestationInventory(
  requirements: ReleaseRequirements,
): Pick<ReleaseEvidenceAttestation, 'calculatorIds' | 'sourceVersions'> {
  return {
    calculatorIds: [...requirements.calculatorIds],
    sourceVersions: { ...requirements.sourceVersions },
  };
}
