import type { VersionNegotiationOptions } from '@modelcontextprotocol/client';

export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const UNSUPPORTED_MODERN_PROTOCOL_VERSION = '2099-01-01';

export type ProtocolEra = 'legacy' | 'modern';

export function versionNegotiationForEra(era: ProtocolEra): VersionNegotiationOptions {
  return { mode: era === 'legacy' ? 'legacy' : { pin: MODERN_PROTOCOL_VERSION } };
}

export function modernRequestMeta(
  clientName = 'oathmcp-test',
  protocolVersion = MODERN_PROTOCOL_VERSION,
) {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': { name: clientName, version: '0.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

export function modernRequestHeaders(
  method: string,
  name?: string,
  protocolVersion = MODERN_PROTOCOL_VERSION,
): Record<string, string> {
  return {
    'MCP-Protocol-Version': protocolVersion,
    'Mcp-Method': method,
    ...(name === undefined ? {} : { 'Mcp-Name': name }),
  };
}

export function modernJsonRpcRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    id?: number;
    clientName?: string;
    protocolVersion?: string;
  } = {},
) {
  const protocolVersion = options.protocolVersion ?? MODERN_PROTOCOL_VERSION;
  return {
    jsonrpc: '2.0' as const,
    id: options.id ?? 1,
    method,
    params: {
      ...params,
      _meta: modernRequestMeta(options.clientName, protocolVersion),
    },
  };
}

export function mcpPostRequest(
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export async function readJsonRpcResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  const data = text.split(/\r?\n/u)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  if (data === undefined) {
    throw new Error('MCP SSE response did not contain a data event.');
  }
  return JSON.parse(data) as Record<string, unknown>;
}

export async function exchangeJsonRpc(
  body: unknown,
  send: (init: RequestInit) => Promise<Response>,
  headers: Record<string, string> = {},
) {
  const response = await send(mcpPostRequest(body, headers));
  return {
    response,
    message: await readJsonRpcResponse(response),
  };
}

export function jsonRpcResult(message: Record<string, unknown>): Record<string, unknown> {
  const result = message.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Expected a JSON-RPC result object.');
  }
  return result as Record<string, unknown>;
}
