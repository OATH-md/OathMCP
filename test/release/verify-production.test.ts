import { describe, expect, it } from 'vitest';
import { loadSpecs } from '../../src/engine/index.js';
import { PKG_VERSION } from '../../src/server/spec-data.generated.js';
import { verifyMcpSurface } from '../../scripts/release/verify-production.mjs';
import { startLoopbackHttp } from '../support/transport-harness.js';

describe('production MCP verifier', () => {
  it('proves the local compact endpoint in modern and legacy eras', async () => {
    const server = await startLoopbackHttp({ mode: 'compact' });
    try {
      await expect(verifyMcpSurface(server.url.origin, {
        version: PKG_VERSION,
        attestation: { calculatorIds: [...loadSpecs().keys()] },
        newCalculatorIds: ['bmi'],
      })).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  }, 60_000);
});
