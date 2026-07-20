import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { handleRequest } from './index.js';

const expectedHsts = 'max-age=31536000; includeSubDomains';

test('redirects plaintext requests to the identical HTTPS URL', async () => {
  const assets = { fetch: () => assert.fail('assets must not be read before redirecting') };
  const response = await handleRequest(
    new Request('http://mcp.oath.md/docs/guides/quickstart/?source=test'),
    assets,
  );

  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://mcp.oath.md/docs/guides/quickstart/?source=test');
  assert.equal(response.headers.get('strict-transport-security'), expectedHsts);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('delegates HTTPS requests to static assets and hardens the response', async () => {
  let delegatedRequest;
  const request = new Request('https://mcp.oath.md/docs/');
  const assets = {
    fetch(received) {
      delegatedRequest = received;
      return new Response('documentation', { headers: { 'Content-Type': 'text/html' } });
    },
  };

  const response = await worker.fetch(request, { ASSETS: assets });

  assert.equal(delegatedRequest, request);
  assert.equal(await response.text(), 'documentation');
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.equal(response.headers.get('strict-transport-security'), expectedHsts);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
