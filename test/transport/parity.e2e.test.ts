import { describe, expect, it } from 'vitest';
import type { CatalogMode } from '../../src/server/build-tools.js';
import {
  captureTransportContract,
  connectTransport,
  type TransportKind,
} from '../support/transport-harness.js';
import type { ProtocolEra } from '../support/protocol-fixtures.js';

const MODES = ['full', 'compact'] satisfies CatalogMode[];
const MATRIX = [
  { era: 'legacy', kind: 'in-memory' },
  { era: 'legacy', kind: 'stdio' },
  { era: 'legacy', kind: 'http' },
  { era: 'legacy', kind: 'worker' },
  { era: 'modern', kind: 'stdio' },
  { era: 'modern', kind: 'http' },
  { era: 'modern', kind: 'worker' },
] satisfies { era: ProtocolEra; kind: TransportKind }[];

function keyOf(entry: (typeof MATRIX)[number]): string {
  return `${entry.era}:${entry.kind}`;
}

function applicationContract(snapshot: Record<string, unknown>): Record<string, unknown> {
  const contract = { ...snapshot };
  delete contract.protocolEra;
  return contract;
}

describe('real MCP transport parity', () => {
  it('rejects an impossible modern in-memory test connection', async () => {
    await expect(connectTransport('in-memory', 'full', 'modern'))
      .rejects.toThrow('legacy-only test surface');
  });

  it('runs the full/compact legacy+modern transport matrix sequentially', async () => {
    const byMode = new Map<CatalogMode, Map<string, Record<string, unknown>>>();

    for (const mode of MODES) {
      const snapshots = new Map<string, Record<string, unknown>>();
      for (const entry of MATRIX) {
        const label = `${mode} ${keyOf(entry)}`;
        const connection = await connectTransport(entry.kind, mode, entry.era);
        try {
          const snapshot = await captureTransportContract(connection.client, mode);
          expect(snapshot.protocolEra, `${label} negotiated era`).toBe(entry.era);
          snapshots.set(keyOf(entry), snapshot);
        } finally {
          await connection.close();
        }
        expect(connection.stderr(), `${label} stderr`).not.toMatch(/patient|input|error/i);
      }
      const baseline = snapshots.get('legacy:in-memory');
      expect(baseline, `${mode} baseline`).toBeDefined();
      for (const entry of MATRIX.slice(1)) {
        const snapshot = snapshots.get(keyOf(entry));
        expect(
          applicationContract(snapshot ?? {}),
          `${mode} ${keyOf(entry)} differs from legacy:in-memory`,
        ).toEqual(applicationContract(baseline ?? {}));
      }
      byMode.set(mode, snapshots);
    }

    for (const entry of MATRIX) {
      const label = keyOf(entry);
      const full = byMode.get('full')?.get(label)?.sentinelResults as
        | Record<string, unknown>
        | undefined;
      const compact = byMode.get('compact')?.get(label)?.sentinelResults as
        | Record<string, { result: { result: unknown } }>
        | undefined;
      expect(full, `${label} full sentinels`).toBeDefined();
      expect(compact, `${label} compact sentinels`).toBeDefined();
      for (const [id, clinicalResult] of Object.entries(full ?? {})) {
        expect(compact?.[id]?.result.result, `${label} ${id} direct/compact`)
          .toEqual(clinicalResult);
      }
    }
  }, 120_000);
});
