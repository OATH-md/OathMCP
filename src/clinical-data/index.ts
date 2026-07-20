export { validateClinicalDataAsset, evaluateLinearTable, evaluateLookupTable, tableById } from './schema.js';
import type { VersionedClinicalDataAsset } from './schema.js';
import { EOS_KAISER_MODELS } from './eos-kaiser-2017.js';
import { GRACE_2006 } from './grace-2006.js';
import { KDPI_OPTN_2025 } from './kdpi-optn.js';
import type { CalcSpec } from '../engine/spec-schema.js';
export type { VersionedClinicalDataAsset } from './schema.js';
export { EOS_KAISER_MODELS, GRACE_2006, KDPI_OPTN_2025 };

const clinicalDataAssetEntries = Object.freeze([
  ['eos', EOS_KAISER_MODELS],
  ['grace', GRACE_2006],
  ['kdpi', KDPI_OPTN_2025],
] as const);
const clinicalDataAssetRegistry: ReadonlyMap<string, Readonly<VersionedClinicalDataAsset>> =
  new Map(clinicalDataAssetEntries);

export function clinicalDataAssets(): typeof clinicalDataAssetEntries {
  return clinicalDataAssetEntries;
}

export function clinicalDataAssetFor(calculatorId: string): Readonly<VersionedClinicalDataAsset> | undefined {
  return clinicalDataAssetRegistry.get(calculatorId);
}

export function clinicalDataAssetProblems(
  asset: Readonly<VersionedClinicalDataAsset>,
  spec: Pick<CalcSpec, 'id' | 'clinicalModel' | 'evidence' | 'reviewAfter'>,
  todayIso = new Date().toISOString().slice(0, 10),
): Array<{ code: 'asset.spec_mismatch' | 'asset.review_expired'; message: string }> {
  const model = spec.clinicalModel;
  return [
    ...(asset.calculatorId === spec.id
      ? []
      : [{ code: 'asset.spec_mismatch' as const, message: `asset ${asset.id} belongs to ${asset.calculatorId}, not ${spec.id}` }]),
    ...(asset.sourceIds.every((sourceId) => spec.evidence.some((source) => source.id === sourceId))
      ? []
      : [{ code: 'asset.spec_mismatch' as const, message: `asset ${asset.id} has a source that is not declared by the spec` }]),
    ...(asset.modelVersion === model.modelVersion
      ? []
      : [{ code: 'asset.spec_mismatch' as const, message: `asset ${asset.id} model version does not match the spec` }]),
    ...(asset.id === model.dataSnapshot
      ? []
      : [{ code: 'asset.spec_mismatch' as const, message: `asset ${asset.id} does not match the spec data snapshot` }]),
    ...(asset.effectiveDate === model.effectiveDate
      ? []
      : [{ code: 'asset.spec_mismatch' as const, message: `asset ${asset.id} effective date does not match the spec` }]),
    ...(asset.reviewAfter === spec.reviewAfter
      ? []
      : [{ code: 'asset.spec_mismatch' as const, message: `asset ${asset.id} review date does not match the spec` }]),
    ...(asset.reviewAfter < todayIso
      ? [{ code: 'asset.review_expired' as const, message: `asset ${asset.id} expired after ${asset.reviewAfter}` }]
      : []),
  ];
}
