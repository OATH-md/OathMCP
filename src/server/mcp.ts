/**
 * Server barrel — the `./server` subpath export. Embedders build their own
 * transport around `buildServer()`. `buildServer(): McpServer` returns a
 * TypeScript SDK v2 object; SDK v1 object interoperability is not retained.
 */
export { buildServer } from './build-tools.js';
