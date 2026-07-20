import { afterEach, describe, expect, it } from 'vitest';
import {
  captureHttpFaultContract,
  startLoopbackHttp,
  type LoopbackHttpServer,
} from '../support/transport-harness.js';

const servers: LoopbackHttpServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(async (server) => {
    await server.close();
  }));
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
    expect(contract.invalidVersion.status).toBe(400);
    expect(contract.invalidVersion.body).toMatch(/Unsupported protocol version/i);
  });
});
