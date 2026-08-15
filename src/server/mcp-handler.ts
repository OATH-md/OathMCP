import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { buildServer, type BuildServerOptions } from './build-tools.js';

export function reportMcpInfrastructureError(): void {
  console.error('Error handling MCP request.');
}

export function createOathMcpHandler(
  options: BuildServerOptions = {},
): McpHttpHandler {
  return createMcpHandler(() => buildServer(options), { legacy: 'stateless' });
}
