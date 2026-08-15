import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/client/stdio';
import type { CatalogMode } from '../../src/server/build-tools.js';
import { startHttpServer } from '../../src/server/http.js';
import { connectInMemoryClient } from '../../src/server/in-memory-client.js';
import worker from '../../src/server/worker.js';
import {
  MODERN_PROTOCOL_VERSION,
  UNSUPPORTED_MODERN_PROTOCOL_VERSION,
  modernJsonRpcRequest,
  modernRequestHeaders,
  type ProtocolEra,
  versionNegotiationForEra,
} from './protocol-fixtures.js';

export type TransportKind = 'in-memory' | 'stdio' | 'http' | 'worker';

export interface TransportConnection {
  client: Client;
  close(): Promise<void>;
  stderr(): string;
}

export interface HttpFaultContract {
  malformed: { status: number; body: string };
  unsupportedVersion: { status: number; body: string };
  bodyHeaderMismatch: { status: number; body: string };
  missingMethodHeader: { status: number; body: string };
  missingNameHeader: { status: number; body: string };
}

export interface LoopbackHttpServer {
  server: Server;
  url: URL;
  close(): Promise<void>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export async function startLoopbackHttp(options: {
  mode?: CatalogMode;
  allowedOrigins?: ReadonlySet<string>;
} = {}): Promise<LoopbackHttpServer> {
  const running = startHttpServer({ port: 0, host: '127.0.0.1', ...options });
  await once(running.server, 'listening');
  const { port } = running.server.address() as AddressInfo;
  return {
    server: running.server,
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: running.close,
  };
}

export async function connectTransport(
  kind: TransportKind,
  mode: CatalogMode = 'full',
  era: ProtocolEra = 'legacy',
): Promise<TransportConnection> {
  if (kind === 'in-memory' && era === 'modern') {
    throw new Error('The in-memory transport is a legacy-only test surface.');
  }

  if (kind === 'in-memory') {
    const connection = await connectInMemoryClient(`transport-${kind}-${mode}-${era}`, { mode });
    return {
      client: connection.client,
      stderr: () => '',
      close: connection.close,
    };
  }

  const client = new Client(
    { name: `transport-${kind}-${mode}-${era}`, version: '0.0.0' },
    { versionNegotiation: versionNegotiationForEra(era) },
  );

  if (kind === 'stdio') {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/server/stdio.js'],
      cwd: ROOT,
      env: { ...getDefaultEnvironment(), OATH_MCP_MODE: mode },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    await client.connect(transport);
    return {
      client,
      stderr: () => stderr,
      close: async () => client.close(),
    };
  }

  if (kind === 'http') {
    const server = await startLoopbackHttp({ mode });
    const transport = new StreamableHTTPClientTransport(server.url);
    try {
      await client.connect(transport);
    } catch (error) {
      await server.close();
      throw error;
    }
    return {
      client,
      stderr: () => '',
      close: async () => {
        const failures: unknown[] = [];
        try {
          await client.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await server.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Failed to close the HTTP transport connection.');
        }
      },
    };
  }

  const transport = new StreamableHTTPClientTransport(new URL('https://worker.example/mcp'), {
    fetch: async (input, init) => worker.fetch(new Request(input, init), {
      OATH_MCP_MODE: mode,
    }),
  });
  await client.connect(transport);
  return {
    client,
    stderr: () => '',
    close: async () => client.close(),
  };
}

/** Exercise raw HTTP faults below the MCP Client abstraction. */
export async function captureHttpFaultContract(
  endpoint: string,
  send: (request: Request) => Promise<Response>,
): Promise<HttpFaultContract> {
  const baseHeaders = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  const malformed = await send(new Request(endpoint, {
    method: 'POST',
    headers: baseHeaders,
    body: '{"private":"patient-name"',
  }));
  const unsupportedVersion = await send(new Request(endpoint, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      ...modernRequestHeaders(
        'tools/list',
        undefined,
        UNSUPPORTED_MODERN_PROTOCOL_VERSION,
      ),
    },
    body: JSON.stringify(modernJsonRpcRequest('tools/list', {}, {
      id: 2,
      protocolVersion: UNSUPPORTED_MODERN_PROTOCOL_VERSION,
    })),
  }));
  const bodyHeaderMismatch = await send(new Request(endpoint, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      ...modernRequestHeaders(
        'tools/list',
        undefined,
        UNSUPPORTED_MODERN_PROTOCOL_VERSION,
      ),
    },
    body: JSON.stringify(modernJsonRpcRequest('tools/list', {}, { id: 3 })),
  }));
  const missingMethodHeader = await send(new Request(endpoint, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
    },
    body: JSON.stringify(modernJsonRpcRequest('tools/list', {}, { id: 4 })),
  }));
  const missingNameHeader = await send(new Request(endpoint, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      ...modernRequestHeaders('tools/call'),
    },
    body: JSON.stringify(modernJsonRpcRequest('tools/call', {
      name: 'calculate_bmi',
      arguments: { weight_kg: 70, height_cm: 170 },
    }, { id: 5 })),
  }));
  return {
    malformed: { status: malformed.status, body: await malformed.text() },
    unsupportedVersion: {
      status: unsupportedVersion.status,
      body: await unsupportedVersion.text(),
    },
    bodyHeaderMismatch: {
      status: bodyHeaderMismatch.status,
      body: await bodyHeaderMismatch.text(),
    },
    missingMethodHeader: {
      status: missingMethodHeader.status,
      body: await missingMethodHeader.text(),
    },
    missingNameHeader: {
      status: missingNameHeader.status,
      body: await missingNameHeader.text(),
    },
  };
}

const SENTINELS = [
  ['bmi', { weight_kg: 70, height_cm: 170 }],
  ['qsofa', { respiratory_rate: 24, systolic_bp: 90, altered_mental_status: true }],
  ['meld', {
    creatinine: 2,
    bilirubin: 2,
    inr: 1.5,
    sodium: 135,
    albumin: 3,
    age_at_registration: 40,
    sex: 'male',
    dialysis: false,
  }],
  ['hepb', { hbsag: 'negative', anti_hbc: 'negative', anti_hbs: 'positive' }],
] as const;

function fieldOf(result: unknown, field: string): unknown {
  if (typeof result !== 'object' || result === null) return undefined;
  return (result as Record<string, unknown>)[field];
}

function contentOf(result: unknown): unknown {
  return fieldOf(result, 'structuredContent');
}

function callCalculator(
  client: Client,
  mode: CatalogMode,
  id: string,
  inputs: Record<string, unknown>,
) {
  return mode === 'full'
    ? client.callTool({ name: `calculate_${id}`, arguments: inputs })
    : client.callTool({ name: 'calculate', arguments: { id, inputs } });
}

export async function captureTransportContract(
  client: Client,
  mode: CatalogMode,
): Promise<Record<string, unknown>> {
  const [{ tools }, { prompts }, { resources }] = await Promise.all([
    client.listTools(),
    client.listPrompts(),
    client.listResources(),
  ]);

  const sentinelResults: Record<string, unknown> = {};
  for (const [id, inputs] of SENTINELS) {
    const result = await callCalculator(client, mode, id, inputs);
    sentinelResults[id] = contentOf(result);
  }

  const descriptor = await client.callTool({
    name: 'describe_calculator',
    arguments: { id: 'bmi' },
  });
  const descriptorError = await client.callTool({
    name: 'describe_calculator',
    arguments: { id: 'not_a_calculator' },
  });
  const panel = await client.callTool({
    name: 'calculate_panel',
    arguments: {
      calculators: ['bmi', 'qsofa'],
      inputs: {},
      overrides: {
        bmi: { weight_kg: 70, height_cm: 170 },
        qsofa: { respiratory_rate: 24, systolic_bp: 90, altered_mental_status: true },
      },
    },
  });
  const panelError = await client.callTool({
    name: 'calculate_panel',
    arguments: { calculators: ['bmi', 'bmi'], inputs: {} },
  });
  const evidence = await client.readResource({ uri: 'calc://bmi/evidence' });
  const prompt = await client.getPrompt({
    name: 'interpret_hepb',
    arguments: { hbsag: 'negative', anti_hbc: 'negative', anti_hbs: 'positive' },
  });
  const completion = await client.complete({
    ref: { type: 'ref/prompt', name: 'interpret_abg' },
    argument: { name: 'sample_type', value: 'peri' },
  });
  const engineError = await callCalculator(
    client,
    mode,
    'map',
    { systolic_bp: 80, diastolic_bp: 80 },
  );
  const concurrent = await Promise.all([68, 70, 72].map(async (weight_kg) => {
    const result = await callCalculator(client, mode, 'bmi', { weight_kg, height_cm: 170 });
    return contentOf(result);
  }));

  return {
    protocolEra: client.getProtocolEra(),
    serverVersion: client.getServerVersion(),
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions(),
    tools: tools.map(({ name }) => name),
    prompts: prompts.map(({ name }) => name),
    resources: resources.map(({ uri }) => uri),
    sentinelResults,
    descriptor: contentOf(descriptor),
    descriptorError: {
      isError: fieldOf(descriptorError, 'isError') ?? false,
      structuredContent: contentOf(descriptorError),
    },
    panel: contentOf(panel),
    panelError: {
      isError: fieldOf(panelError, 'isError') ?? false,
      structuredContent: contentOf(panelError),
    },
    evidence: evidence.contents,
    prompt: prompt.messages,
    completion: completion.completion,
    engineError: {
      isError: fieldOf(engineError, 'isError') ?? false,
      content: fieldOf(engineError, 'content'),
      structuredContent: fieldOf(engineError, 'structuredContent'),
    },
    concurrent,
  };
}
