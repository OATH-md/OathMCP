import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startLoopbackHttp,
  type LoopbackHttpServer,
} from '../../test/support/transport-harness.js';
import {
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  exchangeJsonRpc,
  jsonRpcResult,
  modernJsonRpcRequest,
  modernRequestHeaders,
} from '../../test/support/protocol-fixtures.js';
import { startHttpServer } from './http.js';

const servers: LoopbackHttpServer[] = [];

afterEach(async () => {
  const results = await Promise.allSettled(
    servers.splice(0).map((server) => server.close()),
  );
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close Node HTTP test servers.');
  }
});

async function start(allowedOrigins = new Set<string>()): Promise<string> {
  const connection = await startLoopbackHttp({ allowedOrigins });
  servers.push(connection);
  return connection.url.origin;
}

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'http-test', version: '0.0.0' },
  },
});

function initializeRequest(origin?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: initializeBody,
  };
}

function postRaw(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return exchangeJsonRpc(body, (init) => fetch(`${origin}/mcp`, init), headers);
}

describe('Node Streamable HTTP transport', () => {
  it('accepts non-browser requests and an explicitly allowed exact Origin', async () => {
    const url = await start(new Set(['https://app.example']));
    const noOrigin = await fetch(`${url}/mcp`, initializeRequest());
    const allowed = await fetch(`${url}/mcp`, initializeRequest('https://app.example'));
    expect(noOrigin.status).toBe(200);
    expect(allowed.status).toBe(200);
    expect(['application/json', 'text/event-stream'])
      .toContain(noOrigin.headers.get('content-type'));
    expect(['application/json', 'text/event-stream'])
      .toContain(allowed.headers.get('content-type'));
    expect(noOrigin.headers.get('cache-control')).toBe('no-store');
    expect(noOrigin.headers.get('x-content-type-options')).toBe('nosniff');
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');

    const preflight = await fetch(`${url}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase())
      .toBe('accept, content-type, mcp-protocol-version, mcp-method, mcp-name');
  });

  it('serves a modern discovery and tools list through the shared handler', async () => {
    const url = await start();
    const client = new Client(
      { name: 'http-modern-smoke', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getDiscoverResult()).toBeDefined();
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toContain('calculate_bmi');
    } finally {
      await client.close();
    }
  });

  it('keeps raw legacy responses free of modern wire and session fields', async () => {
    const url = await start();
    const initialized = await postRaw(url, JSON.parse(initializeBody));
    expect(initialized.response.status).toBe(200);
    expect(initialized.response.headers.get('mcp-session-id')).toBeNull();
    expect(jsonRpcResult(initialized.message).protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);

    const listed = await postRaw(url, {
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    }, { 'MCP-Protocol-Version': LEGACY_PROTOCOL_VERSION });
    const result = jsonRpcResult(listed.message);
    expect(listed.response.status).toBe(200);
    expect(listed.response.headers.get('mcp-session-id')).toBeNull();
    expect(result).not.toHaveProperty('resultType');
    expect(result).not.toHaveProperty('ttlMs');
    expect(result).not.toHaveProperty('cacheScope');
    expect(result).not.toHaveProperty('_meta');
  });

  it('serves raw modern discovery, schemas, and a complete BMI call', async () => {
    const url = await start();
    const modernPost = (
      method: string,
      params: Record<string, unknown>,
      id: number,
      name?: string,
    ) => postRaw(
      url,
      modernJsonRpcRequest(method, params, { id, clientName: 'raw-http-modern' }),
      modernRequestHeaders(method, name),
    );

    const discovered = await modernPost('server/discover', {}, 1);
    expect(discovered.response.status).toBe(200);
    expect(discovered.response.headers.get('mcp-session-id')).toBeNull();
    expect(jsonRpcResult(discovered.message)).toMatchObject({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      supportedVersions: expect.arrayContaining([MODERN_PROTOCOL_VERSION]),
    });

    const listed = await modernPost('tools/list', {}, 2);
    const listResult = jsonRpcResult(listed.message);
    expect(listed.response.headers.get('mcp-session-id')).toBeNull();
    expect(listResult).toMatchObject({
      resultType: 'complete', ttlMs: 0, cacheScope: 'private',
    });
    const bmi = (listResult.tools as Record<string, unknown>[])
      .find((tool) => tool.name === 'calculate_bmi');
    expect(bmi).toBeDefined();
    const input = bmi?.inputSchema as {
      additionalProperties?: boolean;
      properties?: Record<string, { description?: string }>;
      allOf?: { anyOf?: { required?: string[] }[] }[];
    };
    const output = bmi?.outputSchema as { properties?: Record<string, unknown> };
    expect(input.additionalProperties).toBe(false);
    expect(input.properties?.weight_kg?.description).toBe('Body weight in kilograms.');
    expect(input.properties?.weight?.description)
      .toBe('Compatibility alias for weight_kg. Prefer weight_kg.');
    expect(input.allOf?.[0]?.anyOf).toEqual(expect.arrayContaining([
      { required: ['weight'] },
      { required: ['weight_kg'] },
    ]));
    expect(output.properties).toHaveProperty('results');
    expect(output.properties).toHaveProperty('evidenceUri');

    const called = await modernPost('tools/call', {
      name: 'calculate_bmi',
      arguments: { weight_kg: 70, height_cm: 170 },
    }, 3, 'calculate_bmi');
    const callResult = jsonRpcResult(called.message);
    expect(called.response.headers.get('mcp-session-id')).toBeNull();
    expect(callResult.resultType).toBe('complete');
    expect(callResult.structuredContent).toMatchObject({
      id: 'bmi', evidenceUri: 'calc://bmi/evidence',
    });
  });

  it('closes the HTTP owner idempotently before an asynchronous bind completes', async () => {
    const running = startHttpServer({ port: 0, host: '127.0.0.1' });
    await Promise.all([running.close(), running.close()]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(running.server.listening).toBe(false);
    expect(running.server.address()).toBeNull();
  });

  it('rejects a hostile Origin before parsing a malformed body', async () => {
    const url = await start();
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{not-json',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('Forbidden origin.');
  });

  it('retains SDK Host-header protection for loopback binding', async () => {
    const url = await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(`${url}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          host: 'evil.example',
        },
      }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
      request.end(initializeBody);
    });
    expect(status).toBe(403);
  });

  it('requires exact MCP media types before parsing a body', async () => {
    const url = await start();
    for (const [headers, expectedStatus] of [
      [{ 'content-type': 'application/json' }, 406],
      [{ accept: 'application/jsonp, text/event-streaming', 'content-type': 'application/json' }, 406],
      [{ accept: 'application/json, text/event-stream', 'content-type': 'application/jsonp' }, 415],
      [{ accept: 'application/json, text/event-stream', 'content-type': 'application/json; charset=iso-8859-1' }, 415],
      [{
        accept: 'application/json, text/event-stream',
        'content-encoding': 'compress',
        'content-type': 'application/json',
      }, 415],
    ] as const) {
      const response = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers,
        body: '{bad',
      });
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (expectedStatus === 415) {
        await expect(response.json()).resolves.toMatchObject({
          error: { message: expect.stringContaining('UTF-8') },
        });
      }
    }
  });

  it('defines exact wrong-path and stateless method behavior', async () => {
    const url = await start();
    expect((await fetch(`${url}/wrong`)).status).toBe(404);
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      const response = await fetch(`${url}/mcp`, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('POST');
      expect(response.headers.get('content-type'), method).toBe('application/json; charset=utf-8');
      expect(response.headers.get('cache-control'), method).toBe('no-store');
      expect(await response.json(), method).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
    }

    const oversizedPut = await fetch(`${url}/mcp`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(101 * 1024),
    });
    expect(oversizedPut.status).toBe(405);
    await expect(oversizedPut.json()).resolves.toMatchObject({ error: { code: -32000 } });
  });

  it('rejects JSON-RPC batches and oversized requests before transport dispatch', async () => {
    const url = await start();
    for (const body of [
      '[]',
      `[${initializeBody}]`,
      JSON.stringify([modernJsonRpcRequest('tools/list')]),
    ]) {
      const response = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body,
      });
      expect(response.status, body).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32600, message: expect.stringContaining('batches') },
        id: null,
      });
    }

    const oversized = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload: 'x'.repeat(101 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: -32600, message: 'Request body too large.' },
    });
  });

  it('distinguishes malformed JSON from a valid but invalid JSON-RPC request', async () => {
    const url = await start();
    const request = (body: string) => fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body,
    });

    for (const body of [
      '{}',
      'null',
      '42',
      '{"jsonrpc":"2.0","id":1,"method":42}',
      JSON.stringify({ ...modernJsonRpcRequest('tools/list'), method: 42 }),
    ]) {
      const response = await request(body);
      expect(response.status, body).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: -32600 } });
    }
    const malformed = await request('{bad');
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: -32700 } });

    const empty = await request('');
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ error: { code: -32700 } });
  });
});
