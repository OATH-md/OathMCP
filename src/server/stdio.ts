#!/usr/bin/env node
/**
 * Stdio entry — the `oath-mcp` bin installed by the version-pinned
 * `@oath-md/oath-mcp` package for local client configurations.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer, catalogMode } from './build-tools.js';

const mode = catalogMode(process.env.OATH_MCP_MODE);
void serveStdio(() => buildServer({ mode }), { legacy: 'serve' });
