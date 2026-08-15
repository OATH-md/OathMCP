/** Stateless Streamable HTTP entry for local Node deployments. */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { parseJSONRPCMessage } from '@modelcontextprotocol/server';
import { buildServer, catalogMode, type CatalogMode } from './build-tools.js';
import { originRejection, parseAllowedOrigins } from './origin.js';
import {
  acceptsMediaType,
  isIdentityContentEncoding,
  isJsonContentType,
  MAX_MCP_REQUEST_BYTES,
} from './transport-headers.js';

export interface HttpServerOptions {
  host: string;
  mode?: CatalogMode;
  allowedOrigins?: ReadonlySet<string>;
}

const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
  res.set('Allow', 'POST').status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
};

export function createHttpApp(options: HttpServerOptions): express.Express {
  const app = express();
  const allowedOrigins = options.allowedOrigins ?? new Set<string>();
  const allowedOriginHostnames = [...allowedOrigins]
    .map((origin) => new URL(origin).hostname);
  const mcpApp = createMcpExpressApp({
    host: options.host,
    ...(allowedOriginHostnames.length === 0 ? {} : { allowedOrigins: allowedOriginHostnames }),
  });

  // This parent middleware runs before the SDK app's JSON parser and host
  // validation, so hostile browser requests are rejected before body parsing.
  app.use('/mcp', (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const origin = req.get('origin') ?? null;
    const rejection = originRejection(origin, allowedOrigins);
    if (rejection) {
      res.status(rejection.status).type('text/plain').send(rejection.body);
      return;
    }
    if (origin !== null && allowedOrigins.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Content-Type, MCP-Protocol-Version',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      methodNotAllowed(req, res);
      return;
    }
    const accept = req.get('accept');
    if (!acceptsMediaType(accept, 'application/json') ||
      !acceptsMediaType(accept, 'text/event-stream')) {
      res.status(406).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
        },
        id: null,
      });
      return;
    }
    const contentType = req.get('content-type');
    if (!isJsonContentType(contentType) || !isIdentityContentEncoding(req.get('content-encoding'))) {
      res.status(415).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unsupported Media Type: Content-Type must be application/json with UTF-8 and Content-Encoding must be identity.',
        },
        id: null,
      });
      return;
    }
    const declaredLength = Number(req.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_REQUEST_BYTES) {
      res.status(413).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Request body too large.' },
        id: null,
      });
      return;
    }
    next();
  });
  // Buffer within the 100 KiB streaming-parser limit, then decode as strict
  // UTF-8 and parse exactly once. This distinguishes valid-but-invalid JSON-RPC
  // (-32600) from malformed/empty/non-UTF-8 JSON (-32700), including top-level
  // primitives that Express's default strict JSON parser rejects prematurely.
  app.use('/mcp', express.raw({ limit: MAX_MCP_REQUEST_BYTES, type: () => true, inflate: false }));
  app.use('/mcp', (req, res, next) => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      res.status(400).json({
        jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null,
      });
      return;
    }
    try {
      req.body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      next();
    } catch {
      res.status(400).json({
        jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null,
      });
    }
  });
  app.use(mcpApp);

  app.post('/mcp', async (req, res) => {
    try {
      // Streamable HTTP carries exactly one JSON-RPC message per POST. JSON-RPC
      // batches are not part of MCP and can produce ambiguous lifecycle/tool
      // semantics across clients, so reject them before transport dispatch.
      if (Array.isArray(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request: MCP does not support JSON-RPC batches.' },
          id: null,
        });
        return;
      }
      try {
        parseJSONRPCMessage(req.body);
      } catch {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request' },
          id: null,
        });
        return;
      }
      const server = buildServer({ mode: options.mode ?? 'full' });
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      console.error('Error handling MCP request.');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });
  app.all('/mcp', methodNotAllowed);

  // Sanitize parser/infrastructure failures that occur before the route's own
  // guarded handler. Never reflect request bodies or stack traces.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'status' in error &&
      typeof error.status === 'number' ? error.status : undefined;
    const tooLarge = status === 413;
    const unsupportedMedia = status === 415;
    const clientBodyError = status !== undefined && status >= 400 && status < 500;
    res.status(tooLarge ? 413 : unsupportedMedia ? 415 : clientBodyError ? 400 : 500).json({
      jsonrpc: '2.0',
      error: {
        code: tooLarge || clientBodyError ? -32600 : -32603,
        message: tooLarge
          ? 'Request body too large.'
          : unsupportedMedia
            ? 'Unsupported Media Type'
            : clientBodyError
              ? 'Invalid Request'
              : 'Internal server error',
      },
      id: null,
    });
  });

  return app;
}

export function startHttpServer(
  options: HttpServerOptions & { port: number },
): http.Server {
  return createHttpApp(options).listen(options.port, options.host);
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const mode = catalogMode(process.env.OATH_MCP_MODE);
  const allowedOrigins = parseAllowedOrigins(process.env.OATH_ALLOWED_ORIGINS);
  startHttpServer({ port, host, mode, allowedOrigins }).once('listening', () => {
    console.error(`oath-mcp listening on http://${host}:${port}/mcp`);
  });
}
