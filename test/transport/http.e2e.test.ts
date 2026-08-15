import { afterEach, describe, expect, it } from 'vitest';
import {
  captureHttpFaultContract,
  startLoopbackHttp,
  type LoopbackHttpServer,
} from '../support/transport-harness.js';

const servers: LoopbackHttpServer[] = [];

afterEach(async () => {
  const results = await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close loopback HTTP servers.');
  }
});

async function url(): Promise<string> {
  const server = await startLoopbackHttp();
  servers.push(server);
  return server.url.href;
}

describe('loopback HTTP protocol faults', () => {
  it('returns sanitized JSON-RPC errors for malformed JSON and protocol versions', async () => {
    const endpoint = await url();
    const contract = await captureHttpFaultContract(endpoint, fetch);
    expect(contract.malformed.status).toBe(400);
    expect(JSON.parse(contract.malformed.body)).toEqual({
      jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null,
    });
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
