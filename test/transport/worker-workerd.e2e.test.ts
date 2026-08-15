import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ProtocolEra,
  versionNegotiationForEra,
} from '../support/protocol-fixtures.js';
import { captureTransportContract } from '../support/transport-harness.js';

const harness = createTestHarness({
  workers: [{ configPath: './wrangler.jsonc' }],
});

beforeAll(async () => {
  await harness.listen();
});

afterAll(async () => {
  await harness.close();
});

async function connectWorkerd(era: ProtocolEra): Promise<Client> {
  const client = new Client(
    { name: `workerd-${era}`, version: '0.0.0' },
    { versionNegotiation: versionNegotiationForEra(era) },
  );
  const worker = harness.getWorker();
  const transport = new StreamableHTTPClientTransport(
    new URL('https://worker.example/mcp'),
    {
      fetch: async (input, init) => {
        const body = init?.body;
        if (body !== undefined && body !== null && typeof body !== 'string') {
          throw new TypeError('The MCP workerd test transport expects a JSON string body.');
        }
        const response = await worker.fetch(input.toString(), {
          method: init?.method,
          headers: init?.headers === undefined
            ? undefined
            : Object.fromEntries(new Headers(init.headers).entries()),
          body: body ?? undefined,
        });
        return response as unknown as Response;
      },
    },
  );
  await client.connect(transport);
  return client;
}

async function callCompact(
  client: Client,
  id: string,
  inputs: Record<string, unknown>,
): Promise<void> {
  const result = await client.callTool({
    name: 'calculate',
    arguments: { id, inputs },
  });
  expect(result.isError, id).not.toBe(true);
  expect(result.structuredContent, id).toMatchObject({
    result: {
      calculator: id,
      ok: true,
      result: { id, evidenceUri: `calc://${id}/evidence` },
    },
  });
}

describe('real workerd compact transport', () => {
  it('serves representative calculations and concurrency in both eras', async () => {
    for (const era of ['legacy', 'modern'] satisfies ProtocolEra[]) {
      const client = await connectWorkerd(era);
      try {
        const contract = await captureTransportContract(client, 'compact');
        expect(contract.protocolEra, era).toBe(era);
        expect([...(contract.tools as string[])].sort(), era).toEqual([
          'calculate',
          'calculate_panel',
          'describe_calculator',
          'find_calculator',
        ]);
        expect(contract.resources as string[], era).toContain('calc://bmi/evidence');
        expect([...(contract.prompts as string[])].sort(), era).toEqual([
          'interpret_abg',
          'interpret_csf',
          'interpret_hepb',
        ]);
        expect(contract.sentinelResults as Record<string, unknown>, era).toMatchObject({
          bmi: expect.any(Object),
          qsofa: expect.any(Object),
          meld: expect.any(Object),
          hepb: expect.any(Object),
        });
        expect(contract.concurrent as unknown[], era).toHaveLength(3);

        await callCompact(client, 'meld', {
          creatinine: { value: 176.8, unit: 'umol/L' },
          bilirubin: { value: 34.2, unit: 'umol/L' },
          inr: 1.5,
          sodium: { value: 135, unit: 'mmol/L' },
          albumin: { value: 30, unit: 'g/L' },
          age_at_registration: 40,
          sex: 'male',
          dialysis: false,
        });
      } finally {
        await client.close();
      }
    }
  }, 120_000);
});
