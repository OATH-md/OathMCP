/**
 * Deterministic agent-facing acceptance tests, executed through the MCP
 * boundary without requiring a live model.
 *
 * Curated clinical vignettes protect realistic discovery language and the
 * inputs an agent workflow depends on. Catalog-derived cases then enroll every
 * calculator automatically: its declared purpose must discover its tool, and
 * its first validation-ledger regression vector must produce the reference outputs through
 * the public `calculate_<id>` tool.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import {
  loadSpec,
  loadSpecs,
  type CalcSpec,
} from '../../src/engine/index.js';
import { connectTestClient } from '../support/mcp-client.js';
import { executeValidationCases, loadAuthoritativeReferenceCases, loadValidationDossiers, type ReferenceCase } from '../../src/validation/index.js';
import { VALIDATION_REVIEW_STATES } from '../../src/server/validation-state.generated.js';
import { createValidationCaseRunner } from '../../src/server/validation-case-runner.js';

interface Vignette {
  prompt: string;
  expected: { calculatorId: string; criticalInputs: string[] };
}

interface SelectionCase {
  name: string;
  query: string;
  expectedId: string | null;
  expectedSelection: 'candidate' | 'needs_clarification' | null;
  expectedNoMatchReason?: 'insufficient_intent' | 'not_available' | 'out_of_scope';
}

const here = dirname(fileURLToPath(import.meta.url));
const vignettes = JSON.parse(
  readFileSync(resolve(here, 'vignettes.json'), 'utf8'),
) as Vignette[];
const selectionCases = JSON.parse(
  readFileSync(resolve(here, 'selection-cases.json'), 'utf8'),
) as SelectionCase[];
const catalog = [...loadSpecs().values()].sort((a, b) =>
  a.id.localeCompare(b.id),
);
interface McpCalculation {
  schemaVersion: string;
  id: string;
  results: { name: string; value: number | string | boolean }[];
}

async function findTop(client: Client, query: string): Promise<string[]> {
  const result = await client.callTool({ name: 'find_calculator', arguments: { query } });
  expect(
    result.isError,
    `find_calculator: ${JSON.stringify(result.content)}`,
  ).not.toBe(true);
  expect(result.structuredContent, 'find_calculator response').toBeDefined();
  if (result.structuredContent === undefined) return [];
  const { matches } = result.structuredContent as { matches: { id: string }[] };
  return matches.map((m) => m.id);
}

function catalogQuery(spec: CalcSpec): string {
  return `${spec.name}. ${spec.purposeForAgents}`.slice(0, 500);
}

function assertReferenceOutputs(
  id: string,
  vector: ReferenceCase,
  calculation: McpCalculation,
): void {
  expect(calculation.schemaVersion, id).toBe('1.1');
  expect(calculation.id, id).toBe(id);
  const outputs = new Map(
    calculation.results.map((result) => [result.name, result.value]),
  );

  for (const [name, expected] of Object.entries(vector.expected)) {
    expect(outputs.has(name), `${id}: missing reference output '${name}'`).toBe(
      true,
    );
    const actual = outputs.get(name);

    if (typeof expected === 'number') {
      expect(typeof actual, `${id}.${name}: expected a numeric output`).toBe(
        'number',
      );
      if (typeof actual !== 'number') continue;

      const tolerance = vector.tolerance.value ?? 0;
      const difference = Math.abs(actual - expected);
      const passed = vector.tolerance.mode === 'exact'
        ? Object.is(actual, expected)
        : vector.tolerance.mode === 'absolute'
          ? difference <= tolerance
          : difference <= tolerance * Math.abs(expected);
      expect(passed, `${id}.${name}: got ${actual}, expected ${expected} (${vector.tolerance.mode} ${tolerance})`).toBe(true);
    } else {
      expect(actual, `${id}.${name}`).toEqual(expected);
    }
  }
}

describe('agent-eval: tool selection', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectTestClient('agent-eval');
  });

  it('has vignettes to evaluate', () => {
    expect(vignettes.length).toBeGreaterThan(0);
  });

  it.each(vignettes)(
    'ranks $expected.calculatorId in the top 2 for its vignette',
    async ({ prompt, expected }) => {
      const ranked = await findTop(client, prompt);
      if (expected.calculatorId === 'bsa_dubois') {
        const result = await client.callTool({ name: 'find_calculator', arguments: { query: prompt } });
        const matches = (result.structuredContent as {
          matches: { id: string; selection: string }[];
        }).matches;
        expect(matches).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'bsa', selection: 'needs_clarification' }),
          expect.objectContaining({ id: 'bsa_dubois', selection: 'needs_clarification' }),
        ]));
        return;
      }
      expect(ranked.slice(0, 2)).toContain(expected.calculatorId);
    },
  );

  it.each(selectionCases)('$name returns the safe selection state', async (selectionCase) => {
    const result = await client.callTool({
      name: 'find_calculator',
      arguments: { query: selectionCase.query },
    });
    const discovery = result.structuredContent as {
      status: 'matched' | 'needs_clarification' | 'no_match';
      matches: { id: string; selection: string; matchReason: string; limitations: string[] }[];
      noMatchReason?: 'insufficient_intent' | 'not_available' | 'out_of_scope';
      clarificationQuestion?: string;
    };
    const { matches } = discovery;
    if (selectionCase.expectedId === null) {
      expect(discovery.status).toBe('no_match');
      expect(matches).toEqual([]);
      expect(discovery.noMatchReason).toBe(selectionCase.expectedNoMatchReason);
      expect(discovery.clarificationQuestion).toBeTruthy();
      return;
    }
    const match = matches[0];
    expect(match, selectionCase.query).toBeDefined();
    expect(match?.id).toBe(selectionCase.expectedId);
    expect(match?.selection).toBe(selectionCase.expectedSelection);
    expect(discovery.status).toBe(selectionCase.expectedSelection === 'candidate'
      ? 'matched'
      : 'needs_clarification');
    if (selectionCase.expectedSelection === 'needs_clarification') {
      expect(discovery.clarificationQuestion).toBeTruthy();
    }
    expect(match?.matchReason.length).toBeGreaterThan(0);
    expect(match?.limitations.length).toBeGreaterThan(0);
  });

  it.each(vignettes)(
    '$expected.calculatorId declares every critical input for its vignette',
    ({ expected }) => {
      const spec = loadSpec(expected.calculatorId);
      for (const input of expected.criticalInputs) {
        expect(Object.keys(spec.inputs)).toContain(input);
      }
    },
  );
});

describe('agent-eval: complete calculator catalog', () => {
  let client: Client;
  let compactClient: Client;
  beforeAll(async () => {
    client = await connectTestClient('agent-eval-catalog');
    compactClient = await connectTestClient('agent-eval-compact', { mode: 'compact' });
  });

  it('covers all 40 calculators', () => {
    expect(catalog).toHaveLength(40);
  });

  it.each(catalog)(
    'discovers $id from its agent-facing catalog purpose',
    async (spec) => {
      const ranked = await findTop(client, catalogQuery(spec));
      expect(ranked.slice(0, 2), spec.id).toContain(spec.id);
    },
  );

  it.each(catalog)(
    'calculate_$id returns its reviewed reference outputs through MCP',
    async (spec) => {
      const vector = loadAuthoritativeReferenceCases(spec.id)[0];
      expect(vector, `${spec.id}: missing source-derived reference case`).toBeDefined();
      if (vector === undefined) return;
      const result = await client.callTool({
        name: `calculate_${spec.id}`,
        arguments: vector.inputs,
      });

      expect(
        result.isError,
        `${spec.id}: ${JSON.stringify(result.content)}`,
      ).not.toBe(true);
      expect(result.structuredContent, spec.id).toBeDefined();
      if (result.structuredContent === undefined) return;

      const firstText = (result.content as { type: string; text?: string }[])
        .find((content) => content.type === 'text')?.text;
      expect(firstText).toBe(JSON.stringify(result.structuredContent));
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'resource_link', uri: `calc://${spec.id}/evidence` }),
      ]));

      assertReferenceOutputs(
        spec.id,
        vector,
        result.structuredContent as unknown as McpCalculation,
      );

      const compact = await compactClient.callTool({
        name: 'calculate',
        arguments: { id: spec.id, inputs: vector.inputs },
      });
      expect(compact.isError, JSON.stringify(compact.content)).not.toBe(true);
      const dispatch = compact.structuredContent as {
        result: { calculator: string; ok: boolean; result: McpCalculation };
      };
      expect(dispatch.result).toMatchObject({ calculator: spec.id, ok: true });
      expect(dispatch.result.result).toEqual(result.structuredContent);
      const compactText = (compact.content as { type: string; text?: string }[])
        .find((content) => content.type === 'text')?.text;
      expect(compactText).toBe(JSON.stringify(compact.structuredContent));
      expect(compact.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'resource_link', uri: `calc://${spec.id}/evidence` }),
      ]));
    },
  );
});

describe('agent-eval: measured workflow budget', () => {
  const baselines = {
    full: { catalogBytes: 345_698, workflowResponseBytes: 15_780 },
    compact: { catalogBytes: 26_570, workflowResponseBytes: 15_892 },
  } as const;

  for (const mode of ['full', 'compact'] as const) {
    it(`${mode} choose→describe→calculate→evidence stays within the optimized 5% budget`, async () => {
      const client = await connectTestClient(`agent-eval-budget-${mode}`, { mode });
      const listed = await client.listTools();
      const responses = [];
      responses.push(await client.callTool({
        name: 'find_calculator',
        arguments: { query: 'adult kidney function from serum creatinine' },
      }));
      responses.push(await client.callTool({
        name: 'describe_calculator',
        arguments: { id: 'gfr' },
      }));
      responses.push(await client.callTool({
        name: mode === 'compact' ? 'calculate' : 'calculate_gfr',
        arguments: mode === 'compact'
          ? { id: 'gfr', inputs: { creatinine: 1.2, age: 55, sex: 'male' } }
          : { creatinine: 1.2, age: 55, sex: 'male' },
      }));
      responses.push(await client.readResource({ uri: 'calc://gfr/evidence' }));

      const catalogBytes = Buffer.byteLength(JSON.stringify(listed));
      const workflowResponseBytes = responses.reduce(
        (sum, response) => sum + Buffer.byteLength(JSON.stringify(response)),
        0,
      );
      expect(responses).toHaveLength(4);
      expect(catalogBytes).toBeLessThanOrEqual(Math.ceil(baselines[mode].catalogBytes * 1.05));
      expect(workflowResponseBytes).toBeLessThanOrEqual(
        Math.ceil(baselines[mode].workflowResponseBytes * 1.05),
      );
      if (mode === 'compact') expect(catalogBytes).toBeLessThanOrEqual(32 * 1024);
    });
  }
});

describe('agent-eval: promoted source-derived scenarios', () => {
  it('runs every scenario-verified dossier through direct and compact MCP tools', async () => {
    const direct = await connectTestClient('agent-eval-promoted-direct');
    const clinicalRunner = await createValidationCaseRunner();
    const dossiers = loadValidationDossiers();
    const reviewStates: Readonly<Record<string, { state: string }>> = VALIDATION_REVIEW_STATES;
    const promoted = Object.entries(reviewStates)
      .filter(([, review]) => review.state === 'scenario_verified')
      .map(([id]) => id);

    try {
      for (const id of promoted) {
        const dossier = dossiers.get(id);
        expect(dossier, id).toBeDefined();
        if (dossier === undefined) continue;
        const results = await executeValidationCases(dossier, clinicalRunner);
        const failed = [...results.values()].filter((result) => result.status !== 'passed');
        expect(failed, `${id}: ${JSON.stringify(failed)}`).toEqual([]);
        const evidence = await direct.readResource({ uri: `calc://${id}/evidence` });
        expect(evidence.contents).toEqual(expect.arrayContaining([
          expect.objectContaining({ uri: `calc://${id}/evidence`, mimeType: 'application/json' }),
        ]));
      }
    } finally {
      await clinicalRunner.close();
    }
  });
});
