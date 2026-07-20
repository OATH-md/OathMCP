/**
 * Cloudflare Workers entry — stateless streamable HTTP over the SDK's
 * web-standard transport (fetch `Request` → `Response`). No sessions, no Durable
 * Objects, no paid plan. A fresh `McpServer` is built per request (the SDK
 * forbids reconnecting a connected server); the derived tool/prompt/resource
 * definitions are memoized in module scope, so per-request cost is just object
 * construction.
 *
 * Workers has no filesystem, so `loadSpecs()`'s disk path (`node:fs` +
 * `readdirSync`) is never reachable here: we prime the spec cache and the server
 * version from the build-time-bundled `spec-data.generated.ts` before the first
 * `buildServer()`. Regenerate that module with `npm run gen:specs` (runs
 * automatically on `npm run build`).
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { primeSpecs } from '../engine/index.js';
import { buildServer, catalogMode } from './build-tools.js';
import { originRejection, parseAllowedOrigins } from './origin.js';
import { SPEC_TEXTS, PKG_VERSION } from './spec-data.generated.js';
import { RESPONSIBLE_USE_TEXT } from './responsible-use.generated.js';
import {
  acceptsMediaType,
  isIdentityContentEncoding,
  isJsonContentType,
  MAX_MCP_REQUEST_BYTES,
} from './transport-headers.js';

// One-time init per isolate: validate + cache the bundled specs and pin the
// version. Runs at module load (before any request), replacing the fs read.
primeSpecs(SPEC_TEXTS);

export type WorkerEnv = Partial<Env> & {
  /** Portal-generated token; install as a Worker secret and never commit it. */
  OPENAI_APPS_CHALLENGE?: string;
};

let cachedOriginsValue: string | undefined;
let cachedAllowedOrigins: ReadonlySet<string> = new Set<string>();
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

type BoundedBody =
  | { tooLarge: true }
  | { tooLarge: false; text: string };

/**
 * Read no more than the public request budget from the original stream.
 *
 * `Request.text()` (and especially `request.clone().text()`) buffers an
 * unbounded chunked body before its size can be checked. Reading directly lets
 * the Worker cancel upstream as soon as the first over-budget chunk arrives.
 */
async function readBoundedBody(request: Request): Promise<BoundedBody> {
  if (request.body === null) return { tooLarge: false, text: '' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_MCP_REQUEST_BYTES) {
        await reader.cancel('Request body too large.').catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    tooLarge: false,
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  };
}

function allowedOrigins(value: string | undefined): ReadonlySet<string> {
  if (value !== cachedOriginsValue) {
    cachedOriginsValue = value;
    cachedAllowedOrigins = parseAllowedOrigins(value);
  }
  return cachedAllowedOrigins;
}

function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }),
    {
      status: 405,
      headers: { allow: 'POST', 'content-type': 'application/json' },
    },
  );
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=UTF-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function corsHeaders(origin: string | null, allowed: ReadonlySet<string>): Headers {
  const headers = new Headers();
  headers.set('cache-control', 'no-store');
  if (origin !== null && allowed.has(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-methods', 'POST, OPTIONS');
    headers.set('access-control-allow-headers', 'accept, content-type, mcp-protocol-version');
    headers.set('access-control-max-age', '86400');
    headers.set('vary', 'Origin');
  }
  return headers;
}

function withCors(response: Response, origin: string | null, allowed: ReadonlySet<string>): Response {
  const headers = new Headers(response.headers);
  corsHeaders(origin, allowed).forEach((value, name) => headers.set(name, value));
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('strict-transport-security', STRICT_TRANSPORT_SECURITY);
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function serviceDescriptor(): Response {
  return jsonResponse({
    name: 'oath-mcp',
    version: PKG_VERSION,
    transport: 'stateless-streamable-http',
    endpoint: '/mcp',
    documentation: 'https://mcp.oath.md/docs/',
    responsibleUse: '/responsible-use',
    openAIAppsChallenge: '/.well-known/openai-apps-challenge',
  });
}

function openAIAppsChallenge(env: WorkerEnv): Response {
  const token = env.OPENAI_APPS_CHALLENGE;
  if (token === undefined || token.length === 0) return new Response('Not found', { status: 404 });
  return new Response(token, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=UTF-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function rateLimitRejection(request: Request, env: WorkerEnv): Promise<Response | null> {
  if (env.OATH_RATE_LIMITER === undefined) return null;
  const client = request.headers.get('cf-connecting-ip') ?? 'unidentified-client';
  const { success } = await env.OATH_RATE_LIMITER.limit({ key: `mcp:${client}` });
  if (success) return null;
  return jsonResponse(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Rate limit exceeded.' },
      id: null,
    },
    429,
    { 'retry-after': '60' },
  );
}

async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return Response.redirect('https://mcp.oath.md/docs/', 308);
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      return serviceDescriptor();
    }
    if (url.pathname === '/responsible-use' && request.method === 'GET') {
      return new Response(RESPONSIBLE_USE_TEXT, {
        headers: {
          'cache-control': 'public, max-age=300',
          'content-type': 'text/markdown; charset=UTF-8',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    if (url.pathname === '/.well-known/openai-apps-challenge' && request.method === 'GET') {
      return openAIAppsChallenge(env);
    }
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    const origin = request.headers.get('origin');
    const origins = allowedOrigins(env.OATH_ALLOWED_ORIGINS);
    const rejection = originRejection(
      origin,
      origins,
    );
    if (rejection) {
      return new Response(rejection.body, {
        status: rejection.status,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=UTF-8',
        },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, origins) });
    }
    if (request.method !== 'POST') return withCors(methodNotAllowed(), origin, origins);

    try {
      const limited = await rateLimitRejection(request, env);
      if (limited) return withCors(limited, origin, origins);
      const accept = request.headers.get('accept');
      if (!acceptsMediaType(accept, 'application/json') ||
        !acceptsMediaType(accept, 'text/event-stream')) {
        return withCors(jsonResponse(
          {
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
            },
            id: null,
          },
          406,
        ), origin, origins);
      }
      const contentType = request.headers.get('content-type');
      if (!isJsonContentType(contentType) ||
        !isIdentityContentEncoding(request.headers.get('content-encoding'))) {
        return withCors(jsonResponse(
          {
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Unsupported Media Type: Content-Type must be application/json with UTF-8 and Content-Encoding must be identity.',
            },
            id: null,
          },
          415,
        ), origin, origins);
      }
      const declaredLength = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_REQUEST_BYTES) {
        return withCors(jsonResponse(
          { jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large.' }, id: null },
          413,
        ), origin, origins);
      }
      let body: BoundedBody;
      try {
        body = await readBoundedBody(request);
      } catch {
        return withCors(jsonResponse(
          { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
          400,
        ), origin, origins);
      }
      if (body.tooLarge) {
        return withCors(jsonResponse(
          { jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large.' }, id: null },
          413,
        ), origin, origins);
      }
      const rawBody = body.text;
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return withCors(jsonResponse(
          { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
          400,
        ), origin, origins);
      }
      if (Array.isArray(parsedBody)) {
        return withCors(jsonResponse(
          {
            jsonrpc: '2.0',
            error: { code: -32600, message: 'Invalid Request: MCP does not support JSON-RPC batches.' },
            id: null,
          },
          400,
        ), origin, origins);
      }
      if (!JSONRPCMessageSchema.safeParse(parsedBody).success) {
        return withCors(jsonResponse(
          { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null },
          400,
        ), origin, origins);
      }
      const server = buildServer({
        mode: catalogMode(env.OATH_MCP_MODE),
        version: PKG_VERSION,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true, // plain JSON responses (no SSE) — a calculator needs no streaming
      });
      try {
        await server.connect(transport);
        return withCors(
          await transport.handleRequest(request, { parsedBody }),
          origin,
          origins,
        );
      } finally {
        await Promise.allSettled([transport.close(), server.close()]);
      }
    } catch {
      // handleRequest returns well-formed JSON-RPC error Responses for parse/
      // protocol/tool faults itself; this only catches a genuine infrastructure
      // throw, mirroring http.ts's 500 envelope instead of workerd's bare 500.
      return withCors(jsonResponse(
        { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
        500,
      ), origin, origins);
    }
}

export default {
  async fetch(request: Request, env: WorkerEnv = {}): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }
    return withSecurityHeaders(await handleRequest(request, env));
  },
};
