#!/usr/bin/env node
/**
 * Stdio entry — the `oath-mcp` bin, for local clients
 * (`npx @oath-md/oath-mcp` / `{ command, args }` client configs).
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer, catalogMode } from './build-tools.js';

const mode = catalogMode(process.env.OATH_MCP_MODE);
void serveStdio(() => buildServer({ mode }), { legacy: 'serve' });
