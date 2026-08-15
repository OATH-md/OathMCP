export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

export type ProtocolEra = 'legacy' | 'modern';

export function modernRequestMeta(clientName = 'oathmcp-test') {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: clientName, version: '0.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

export function modernRequestHeaders(
  method: string,
  name?: string,
): Record<string, string> {
  return {
    'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
    'Mcp-Method': method,
    ...(name === undefined ? {} : { 'Mcp-Name': name }),
  };
}
