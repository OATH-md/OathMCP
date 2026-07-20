import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/server/build-tools.js';
import type { BuildServerOptions } from '../../src/server/build-tools.js';

/** Connect a test client to a fresh OathMCP server through linked in-memory transports. */
export async function connectTestClient(
  name: string,
  options: BuildServerOptions = {},
): Promise<Client> {
  const server = buildServer(options);
  const client = new Client({ name, version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
