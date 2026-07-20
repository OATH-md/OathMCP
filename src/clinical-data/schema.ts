import * as z from 'zod/v4';

const Id = z.string().regex(/^[a-z][a-z0-9_.:-]*$/);
const FiniteRecord = z.record(Id, z.number().finite());

const LinearRowSchema = z.strictObject({
  lowerInclusive: z.number().finite(),
  upperExclusive: z.number().finite().optional(),
  base: z.number().finite(),
  slope: z.number().finite(),
  offset: z.number().finite(),
});

const LookupRowSchema = z.strictObject({
  upperInclusive: z.number().finite(),
  value: z.number().finite(),
});

const LinearTableSchema = z.strictObject({
  kind: z.literal('linear'),
  id: Id,
  rows: z.array(LinearRowSchema).nonempty(),
});

const LookupTableSchema = z.strictObject({
  kind: z.literal('lookup'),
  id: Id,
  rows: z.array(LookupRowSchema).nonempty(),
  overflowValue: z.number().finite().optional(),
});

const TableSchema = z.discriminatedUnion('kind', [LinearTableSchema, LookupTableSchema]);

export const VersionedClinicalDataAssetSchema = z.strictObject({
  id: Id,
  calculatorId: Id,
  modelVersion: z.string().min(1),
  sourceIds: z.array(Id).nonempty().refine((ids) => new Set(ids).size === ids.length, 'source IDs must be unique'),
  effectiveDate: z.iso.date().optional(),
  reviewAfter: z.iso.date(),
  coefficients: FiniteRecord,
  categories: FiniteRecord,
  tables: z.array(TableSchema),
}).superRefine((asset, ctx) => {
  if (asset.effectiveDate !== undefined && asset.reviewAfter < asset.effectiveDate) {
    ctx.addIssue({ code: 'custom', path: ['reviewAfter'], message: 'reviewAfter cannot precede effectiveDate' });
  }
  const tableIds = asset.tables.map((table) => table.id);
  if (new Set(tableIds).size !== tableIds.length) {
    ctx.addIssue({ code: 'custom', path: ['tables'], message: 'table IDs must be unique' });
  }
  for (const [tableIndex, table] of asset.tables.entries()) {
    if (table.kind === 'lookup') {
      for (let index = 1; index < table.rows.length; index += 1) {
        if (table.rows[index - 1]!.upperInclusive >= table.rows[index]!.upperInclusive) {
          ctx.addIssue({ code: 'custom', path: ['tables', tableIndex, 'rows', index], message: 'lookup bounds must be strictly increasing' });
        }
      }
      continue;
    }
    for (const [rowIndex, row] of table.rows.entries()) {
      if (row.upperExclusive !== undefined && row.upperExclusive <= row.lowerInclusive) {
        ctx.addIssue({ code: 'custom', path: ['tables', tableIndex, 'rows', rowIndex], message: 'linear row upper bound must exceed its lower bound' });
      }
      const next = table.rows[rowIndex + 1];
      if (next !== undefined && row.upperExclusive !== next.lowerInclusive) {
        ctx.addIssue({ code: 'custom', path: ['tables', tableIndex, 'rows', rowIndex], message: 'linear rows must be contiguous' });
      }
    }
  }
});

export type VersionedClinicalDataAsset = z.infer<typeof VersionedClinicalDataAssetSchema>;
export type ClinicalDataTable = VersionedClinicalDataAsset['tables'][number];

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function validateClinicalDataAsset(asset: unknown): Readonly<VersionedClinicalDataAsset> {
  return deepFreeze(VersionedClinicalDataAssetSchema.parse(asset));
}

export function tableById(
  asset: Readonly<VersionedClinicalDataAsset>,
  id: string,
): Readonly<ClinicalDataTable> {
  const table = asset.tables.find((candidate) => candidate.id === id);
  if (table === undefined) throw new Error(`Clinical data asset '${asset.id}' has no table '${id}'.`);
  return table;
}

export function evaluateLinearTable(table: Readonly<ClinicalDataTable>, value: number): number {
  if (table.kind !== 'linear') throw new Error(`Clinical data table '${table.id}' is not linear.`);
  const row = table.rows.find((candidate) =>
    value >= candidate.lowerInclusive &&
    (candidate.upperExclusive === undefined || value < candidate.upperExclusive));
  if (row === undefined) throw new Error(`Clinical data table '${table.id}' has no row for ${value}.`);
  return row.base + (value - row.offset) * row.slope;
}

export function evaluateLookupTable(table: Readonly<ClinicalDataTable>, value: number): number {
  if (table.kind !== 'lookup') throw new Error(`Clinical data table '${table.id}' is not a lookup.`);
  let low = 0;
  let high = table.rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (value <= table.rows[middle]!.upperInclusive) high = middle;
    else low = middle + 1;
  }
  return table.rows[low]?.value ?? table.overflowValue ?? table.rows[table.rows.length - 1]!.value;
}
