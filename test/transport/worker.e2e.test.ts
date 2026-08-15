import { describe, expect, it } from 'vitest';
import worker from '../../src/server/worker.js';
import { captureHttpFaultContract } from '../support/transport-harness.js';

describe('Worker protocol faults', () => {
  it('returns sanitized JSON-RPC errors for malformed JSON and protocol versions', async () => {
    const endpoint = 'https://worker.example/mcp';
    const contract = await captureHttpFaultContract(endpoint, (request) => worker.fetch(request));
    expect(contract.malformed.status).toBe(400);
    expect(contract.malformed.body).toMatch(/Parse error/i);
    expect(contract.malformed.body).not.toContain('patient-name');
    expect(contract.unsupportedVersion.status).toBe(400);
    expect(JSON.parse(contract.unsupportedVersion.body)).toMatchObject({
      error: { code: -32022, message: expect.stringMatching(/Unsupported protocol version/i) },
    });
    expect(contract.bodyHeaderMismatch.status).toBe(400);
    expect(JSON.parse(contract.bodyHeaderMismatch.body)).toMatchObject({
      error: { code: -32020, message: expect.stringMatching(/headers and body disagree/i) },
    });
    for (const missing of [contract.missingMethodHeader, contract.missingNameHeader]) {
      expect(missing.status).toBe(400);
      expect(JSON.parse(missing.body)).toMatchObject({ error: { code: -32020 } });
    }
  });
});
