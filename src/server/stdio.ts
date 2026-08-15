#!/usr/bin/env node
/**
 * Stdio entry — the `oath-mcp` bin, for local clients
 * (`npx oath-mcp` / `{ command, args }` client configs).
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { buildServer, catalogMode } from './build-tools.js';

await buildServer({ mode: catalogMode(process.env.OATH_MCP_MODE) }).connect(
  new StdioServerTransport(),
);
