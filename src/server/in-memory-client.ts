import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, type BuildServerOptions } from './build-tools.js';

export async function connectInMemoryClient(
  name: string,
  options: BuildServerOptions = {},
) {
  const server = buildServer(options);
  const client = new Client({ name, version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async (): Promise<void> => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}
