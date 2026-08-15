/** Stateless Streamable HTTP entry for local Node deployments. */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { parseJSONRPCMessage } from '@modelcontextprotocol/server';
import { catalogMode, type CatalogMode } from './build-tools.js';
import {
  createOathMcpHandler,
  reportMcpInfrastructureError,
} from './mcp-handler.js';
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

interface OathHttpApp extends express.Express {
  closeMcpHandler(): Promise<void>;
}

export interface RunningHttpServer {
  server: http.Server;
  close(): Promise<void>;
}

const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
  res.set('Allow', 'POST').status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
};

export function createHttpApp(options: HttpServerOptions): OathHttpApp {
  const app = express() as OathHttpApp;
  const allowedOrigins = options.allowedOrigins ?? new Set<string>();
  const allowedOriginHostnames = [...allowedOrigins]
    .map((origin) => new URL(origin).hostname);
  const mcpApp = createMcpExpressApp({
    host: options.host,
    ...(allowedOriginHostnames.length === 0 ? {} : { allowedOrigins: allowedOriginHostnames }),
  });
  const handler = createOathMcpHandler({ mode: options.mode ?? 'full' });
  const nodeHandler = toNodeHandler({
    fetch: async (request, requestOptions) => {
      const response = await handler.fetch(request, requestOptions);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    },
  }, { onerror: reportMcpInfrastructureError });
  let closeMcpHandlerPromise: Promise<void> | undefined;
  app.closeMcpHandler = () => {
    closeMcpHandlerPromise ??= handler.close();
    return closeMcpHandlerPromise;
  };

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
        'Access-Control-Allow-Headers': 'Accept, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
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
    await nodeHandler(req, res, req.body);
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
): RunningHttpServer {
  const app = createHttpApp(options);
  const server = app.listen(options.port, options.host);
  let serverClosed = false;
  server.once('close', () => {
    serverClosed = true;
  });
  let closePromise: Promise<void> | undefined;
  return {
    server,
    close() {
      closePromise ??= (async () => {
        const readyToClose = server.listening || serverClosed
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              server.off('listening', onListening);
              server.off('close', onClose);
              server.off('error', onError);
            };
            const onListening = () => {
              cleanup();
              resolve();
            };
            const onClose = () => {
              cleanup();
              resolve();
            };
            const onError = (error: Error) => {
              cleanup();
              reject(error);
            };
            server.once('listening', onListening);
            server.once('close', onClose);
            server.once('error', onError);
            if (server.listening) onListening();
            else if (serverClosed) onClose();
          });
        await app.closeMcpHandler();
        await readyToClose;
        if (serverClosed) return;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      })();
      return closePromise;
    },
  };
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
  const running = startHttpServer({ port, host, mode, allowedOrigins });
  running.server.once('listening', () => {
    console.error(`oath-mcp listening on http://${host}:${port}/mcp`);
  });
}
