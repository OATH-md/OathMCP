import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { clinicalModelProvenance, loadSpec } from '../engine/index.js';
import {
  EOS_KAISER_MODELS,
  GRACE_2006,
  KDPI_OPTN_2025,
  clinicalDataAssetProblems,
  clinicalDataAssets,
  evaluateLinearTable,
  evaluateLookupTable,
  tableById,
  validateClinicalDataAsset,
} from './index.js';

const GRACE_LINEAR_FIXTURES = {
  age_points: [[0, 35, 0, 0, 0], [35, 45, 0, 1.8, 35], [45, 55, 18, 1.8, 45], [55, 65, 36, 1.8, 55], [65, 75, 54, 1.9, 65], [75, 85, 73, 1.8, 75], [85, 90, 91, 1.8, 85], [90, null, 100, 0, 90]],
  heart_rate_points: [[0, 70, 0, 0, 0], [70, 80, 0, 0.3, 70], [80, 90, 3, 0.2, 80], [90, 100, 5, 0.3, 90], [100, 110, 8, 0.2, 100], [110, 150, 10, 0.3, 110], [150, 200, 22, 0.3, 150], [200, null, 34, 0, 200]],
  systolic_bp_points: [[0, 80, 40, 0, 0], [80, 100, 40, -0.3, 80], [100, 110, 34, -0.3, 100], [110, 120, 31, -0.4, 110], [120, 130, 27, -0.3, 120], [130, 140, 24, -0.3, 130], [140, 150, 20, -0.4, 140], [150, 160, 17, -0.3, 150], [160, 180, 14, -0.3, 160], [180, 200, 8, -0.4, 180], [200, null, 0, 0, 200]],
  creatinine_points: [[0, 0.2, 0, 5, 0], [0.2, 0.4, 1, 10, 0.2], [0.4, 0.6, 3, 5, 0.4], [0.6, 0.8, 4, 10, 0.6], [0.8, 1, 6, 5, 0.8], [1, 1.2, 7, 5, 1], [1.2, 1.4, 8, 10, 1.2], [1.4, 1.6, 10, 5, 1.4], [1.6, 1.8, 11, 10, 1.6], [1.8, 2, 13, 5, 1.8], [2, 3, 14, 7, 2], [3, 4, 21, 7, 3], [4, null, 28, 0, 4]],
} as const;

const GRACE_MORTALITY_FIXTURE = [
  [6, 0.2], [27, 0.4], [39, 0.6], [48, 0.8], [55, 1], [60, 1.2], [65, 1.4], [69, 1.6], [73, 1.8], [76, 2],
  [88, 3], [97, 4], [104, 5], [110, 6], [115, 7], [119, 8], [123, 9], [126, 10], [129, 11], [132, 12],
  [134, 13], [137, 14], [139, 15], [141, 16], [143, 17], [145, 18], [147, 19], [149, 20], [150, 21], [152, 22],
  [153, 23], [155, 24], [156, 25], [158, 26], [159, 27], [160, 28], [162, 29], [163, 30], [174, 40], [183, 50],
  [191, 60], [200, 70], [208, 80], [219, 90], [285, 99],
] as const;

describe('versioned clinical-data assets', () => {
  it('are immutable and match each owning spec snapshot and model version', () => {
    for (const [calculatorId, asset] of clinicalDataAssets()) {
      expect(Object.isFrozen(asset)).toBe(true);
      expect(Object.isFrozen(asset.tables)).toBe(true);
      expect(clinicalDataAssetProblems(asset, loadSpec(calculatorId), '2026-07-15')).toEqual([]);
    }
  });

  it('rejects non-contiguous linear rows and non-increasing lookup bounds', () => {
    const common = {
      id: 'test.asset', calculatorId: 'test', modelVersion: '1', sourceIds: ['source'],
      effectiveDate: '2026-01-01', reviewAfter: '2027-01-01', coefficients: {}, categories: {},
    };
    expect(() => validateClinicalDataAsset({ ...common, tables: [{
      kind: 'linear', id: 'bad', rows: [
        { lowerInclusive: 0, upperExclusive: 1, base: 0, slope: 1, offset: 0 },
        { lowerInclusive: 2, base: 1, slope: 1, offset: 2 },
      ],
    }] })).toThrow(/contiguous/);
    expect(() => validateClinicalDataAsset({ ...common, tables: [{
      kind: 'lookup', id: 'bad', rows: [
        { upperInclusive: 2, value: 1 }, { upperInclusive: 2, value: 2 },
      ],
    }] })).toThrow(/strictly increasing/);
  });

  it('evaluates every GRACE row at its lower knot and preserves the published pulse-200 discontinuity', () => {
    for (const [tableId, fixtures] of Object.entries(GRACE_LINEAR_FIXTURES)) {
      const table = tableById(GRACE_2006, tableId);
      expect(table.kind).toBe('linear');
      if (table.kind !== 'linear') continue;
      expect(table.rows.map((row) => [row.lowerInclusive, row.upperExclusive ?? null, row.base, row.slope, row.offset])).toEqual(fixtures);
      for (const [lower, upper, base, slope, offset] of fixtures) {
        expect(evaluateLinearTable(table, lower)).toBeCloseTo(base, 12);
        if (upper !== null) {
          const justBelow = upper - Math.max(1e-9, (upper - lower) * 1e-6);
          expect(evaluateLinearTable(table, justBelow)).toBeCloseTo(base + (justBelow - offset) * slope, 8);
        }
      }
    }
    const pulse = tableById(GRACE_2006, 'heart_rate_points');
    expect(evaluateLinearTable(pulse, 199.999)).toBeCloseTo(36.9997, 4);
    expect(evaluateLinearTable(pulse, 200)).toBe(34);
  });

  it('matches every independently transcribed GRACE mortality anchor', () => {
    const table = tableById(GRACE_2006, 'mortality_percent');
    expect(table.kind).toBe('lookup');
    if (table.kind !== 'lookup') return;
    expect(table.rows.map((row) => [row.upperInclusive, row.value])).toEqual(GRACE_MORTALITY_FIXTURE);
    for (const [upper, risk] of GRACE_MORTALITY_FIXTURE) expect(evaluateLookupTable(table, upper)).toBe(risk);
  });

  it('preserves all 100 current OPTN KDPI percentile bounds', () => {
    const mapping = tableById(KDPI_OPTN_2025, 'kdpi_percentile');
    expect(mapping.kind).toBe('lookup');
    if (mapping.kind !== 'lookup') return;
    expect(mapping.rows).toHaveLength(100);
    expect(createHash('sha256').update(JSON.stringify(mapping.rows)).digest('hex')).toBe('4a080a0a7ed8903848b8b48b26a58a8daa25673331ebfaedabcf842808a26ed6');
    for (const row of mapping.rows) {
      expect(evaluateLookupTable(mapping, row.upperInclusive)).toBe(row.value);
    }
    for (let index = 1; index < mapping.rows.length; index += 1) {
      const previous = mapping.rows[index - 1]!;
      const current = mapping.rows[index]!;
      const inside = previous.upperInclusive + (current.upperInclusive - previous.upperInclusive) / 2;
      expect(evaluateLookupTable(mapping, inside)).toBe(current.value);
    }
    expect(evaluateLookupTable(mapping, Number.POSITIVE_INFINITY)).toBe(100);
  });

  it('exposes expired model and asset state under a deterministic date probe', () => {
    const spec = loadSpec('eos');
    expect(clinicalModelProvenance(spec, '2026-10-14')).toMatchObject({
      modelVersion: EOS_KAISER_MODELS.modelVersion,
      reviewAfter: '2026-10-13',
      stale: true,
    });
    expect(clinicalDataAssetProblems(EOS_KAISER_MODELS, spec, '2026-10-14'))
      .toEqual([{ code: 'asset.review_expired', message: `asset ${EOS_KAISER_MODELS.id} expired after 2026-10-13` }]);
  });

  it('rejects asset identity, source, effective-date, and review-date drift from the spec', () => {
    const spec = loadSpec('grace');
    const drifted = validateClinicalDataAsset({
      ...GRACE_2006,
      calculatorId: 'eos',
      sourceIds: ['missing_source'],
      effectiveDate: '2014-01-31',
      reviewAfter: '2026-10-14',
    });
    expect(clinicalDataAssetProblems(drifted, spec, '2026-07-15').map((problem) => problem.message)).toEqual([
      `asset ${GRACE_2006.id} belongs to eos, not grace`,
      `asset ${GRACE_2006.id} has a source that is not declared by the spec`,
      `asset ${GRACE_2006.id} effective date does not match the spec`,
      `asset ${GRACE_2006.id} review date does not match the spec`,
    ]);
  });
});
