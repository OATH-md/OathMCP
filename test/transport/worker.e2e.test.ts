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
    expect(contract.invalidVersion.status).toBe(400);
    expect(contract.invalidVersion.body).toMatch(/Unsupported protocol version/i);
  });
});
