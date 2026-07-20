import { describe, expect, it } from 'vitest';
import type { CatalogMode } from '../../src/server/build-tools.js';
import {
  captureTransportContract,
  connectTransport,
  type TransportKind,
} from '../support/transport-harness.js';

const TRANSPORTS: TransportKind[] = ['in-memory', 'stdio', 'http', 'worker'];
const MODES = ['full', 'compact'] satisfies CatalogMode[];

describe('real MCP transport parity', () => {
  it('returns identical transport contracts and direct/compact clinical payloads', async () => {
    const modeEntries = await Promise.all(MODES.map(async (mode) => {
      const entries = await Promise.all(TRANSPORTS.map(async (kind) => {
        const connection = await connectTransport(kind, mode);
        let snapshot: Record<string, unknown>;
        try {
          snapshot = await captureTransportContract(connection.client, mode);
        } finally {
          await connection.close();
        }
        expect(connection.stderr(), `${kind} stderr`).not.toMatch(/patient|input|error/i);
        return [kind, snapshot] as const;
      }));
      const snapshots = Object.fromEntries(entries) as Record<
        TransportKind,
        Record<string, unknown>
      >;

      for (const kind of TRANSPORTS.slice(1)) {
        expect(snapshots[kind], `${kind} differs from in-memory`).toEqual(snapshots['in-memory']);
      }
      return [mode, snapshots] as const;
    }));
    const byMode = Object.fromEntries(modeEntries) as Record<
      CatalogMode,
      Record<TransportKind, Record<string, unknown>>
    >;

    for (const kind of TRANSPORTS) {
      const full = byMode.full[kind].sentinelResults as Record<string, unknown>;
      const compact = byMode.compact[kind].sentinelResults as Record<
        string,
        { result: { result: unknown } }
      >;
      for (const [id, clinicalResult] of Object.entries(full)) {
        expect(compact[id]?.result.result, `${kind} ${id} direct/compact`).toEqual(clinicalResult);
      }
    }
  }, 120_000);
});
