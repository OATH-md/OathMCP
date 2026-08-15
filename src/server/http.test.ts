import http, { type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { startLoopbackHttp } from '../../test/support/transport-harness.js';

const LEGACY_PROTOCOL_VERSION = '2025-11-25';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

async function start(allowedOrigins = new Set<string>()): Promise<string> {
  const connection = await startLoopbackHttp({ allowedOrigins });
  servers.push(connection.server);
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

describe('Node Streamable HTTP transport', () => {
  it('accepts non-browser requests and an explicitly allowed exact Origin', async () => {
    const url = await start(new Set(['https://app.example']));
    const noOrigin = await fetch(`${url}/mcp`, initializeRequest());
    const allowed = await fetch(`${url}/mcp`, initializeRequest('https://app.example'));
    expect(noOrigin.status).toBe(200);
    expect(allowed.status).toBe(200);
    expect(noOrigin.headers.get('content-type')).toBe('application/json');
    expect(allowed.headers.get('content-type')).toBe('application/json');
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
    for (const body of ['[]', `[${initializeBody}]`]) {
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

    for (const body of ['{}', 'null', '42', '{"jsonrpc":"2.0","id":1,"method":42}']) {
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
