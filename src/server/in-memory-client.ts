import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer, type BuildServerOptions } from './build-tools.js';

export async function connectInMemoryClient(
  name: string,
  options: BuildServerOptions = {},
) {
  const server = buildServer(options);
  // Linked in-memory clients are intentionally legacy-only fast test surfaces;
  // modern serving has no in-memory entrypoint.
  const client = new Client(
    { name, version: '1.0.0' },
    { versionNegotiation: { mode: 'legacy' } },
  );
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
