import { describe, expect, it } from 'vitest';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { convert, loadSpec } from '../engine/index.js';
import type { InputSpec } from '../engine/index.js';
import { connectTestClient } from '../../test/support/mcp-client.js';
import { loadAuthoritativeReferenceCases } from '../validation/load-validation.js';

const CALCULATOR_IDS = [
  'aa_gradient',
  'abg',
  'anion_gap',
  'apgar',
  'bmi',
  'bsa',
  'bsa_dubois',
  'carboplatin_auc',
  'chadsvasc',
  'chemo_dose_bsa',
  'child_pugh',
  'corrected_calcium',
  'creatinine_clearance',
  'csf',
  'eos',
  'fib4',
  'free_water_deficit',
  'gad7',
  'gcs',
  'gfr',
  'gir',
  'grace',
  'hepb',
  'ibw',
  'ich_volume',
  'kdpi',
  'map',
  'meld',
  'mews',
  'morse_fall_scale',
  'neonatal_measurements',
  'nihss',
  'oxygenation_index',
  'pews',
  'qsofa',
  'r_factor',
  'ranson',
  'sodium_deficit',
  'timi',
  'wells_dvt',
] as const;

const DISPATCH_TOOLS = [
  'find_calculator',
  'describe_calculator',
  'calculate_panel',
] as const;
const PROMPT_IDS = ['abg', 'csf', 'hepb'] as const;

function promptArgument(input: InputSpec, raw: unknown): string {
  if (
    input.kind === 'quantity' &&
    input.quantity !== undefined &&
    typeof raw === 'object' &&
    raw !== null &&
    'value' in raw &&
    'unit' in raw
  ) {
    const supplied = raw as { value: number; unit: string };
    return String(
      convert(
        input.quantity.analyte,
        supplied.value,
        supplied.unit,
        input.quantity.canonicalUnit,
      ),
    );
  }
  return String(raw);
}

async function expectInvalidPromptArguments(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProtocolError);
  expect(caught).toMatchObject({ code: ProtocolErrorCode.InvalidParams });
  expect((caught as Error).message).toMatch(/Invalid (?:params|arguments)/i);
}

describe('MCP catalog contract', () => {
  it('publishes concise clinical-use instructions at initialization', async () => {
    const client = await connectTestClient('catalog-instructions-test');
    expect(client.getInstructions()).toContain('exact population');
    expect(client.getInstructions()).toContain('ask for clarification');
    expect(client.getInstructions()).toContain('not new research');
    expect(client.getInstructions()).toContain('Never invent missing inputs');
    expect(client.getInstructions()).toContain('clinician responsibility');
  });

  it('exposes the exact full-catalog tool, prompt, and resource surfaces', async () => {
    const client = await connectTestClient('catalog-contract-test');
    const [{ tools }, { prompts }, { resources }] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
    ]);
    const [{ tools: repeatedTools }, { prompts: repeatedPrompts }, { resources: repeatedResources }] =
      await Promise.all([
        client.listTools(),
        client.listPrompts(),
        client.listResources(),
      ]);

    expect(tools).toHaveLength(43);
    expect(prompts).toHaveLength(3);
    expect(resources).toHaveLength(41);

    const toolNames = [...CALCULATOR_IDS.map((id) => `calculate_${id}`), ...DISPATCH_TOOLS];
    const promptNames = PROMPT_IDS.map((id) => `interpret_${id}`);
    const resourceUris = [...CALCULATOR_IDS.map((id) => `calc://${id}/evidence`), 'oath://responsible-use'];
    expect(tools.map((tool) => tool.name)).toEqual(toolNames);
    expect(prompts.map((prompt) => prompt.name)).toEqual(promptNames);
    expect(resources.map((resource) => resource.uri)).toEqual(resourceUris);
    expect(repeatedTools.map((tool) => tool.name)).toEqual(toolNames);
    expect(repeatedPrompts.map((prompt) => prompt.name)).toEqual(promptNames);
    expect(repeatedResources.map((resource) => resource.uri)).toEqual(resourceUris);

    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
  });

  it('advertises immutable catalog capabilities so clients can cache lists', async () => {
    const client = await connectTestClient('catalog-capabilities-test');
    expect(client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { listChanged: false },
    });
  });

  it('serves the canonical Responsible Use notice through MCP', async () => {
    const client = await connectTestClient('responsible-use-resource-test');
    const response = await client.readResource({ uri: 'oath://responsible-use' });
    expect(response.contents).toHaveLength(1);
    const content = response.contents[0];
    expect(content.mimeType).toBe('text/markdown');
    expect('text' in content).toBe(true);
    if (!('text' in content)) return;
    expect(content.text).toContain('# Responsible Use');
    expect(content.text).toContain('## Clinical responsibility');
    expect(content.text).toContain('## Deployment and data responsibility');
  });

  it('serves valid evidence JSON for every catalog resource', async () => {
    const client = await connectTestClient('catalog-resource-contract-test');

    for (const id of CALCULATOR_IDS) {
      const uri = `calc://${id}/evidence`;
      const response = await client.readResource({ uri });
      expect(response.contents).toHaveLength(1);
      const content = response.contents[0];
      expect(content.mimeType, uri).toBe('application/json');
      expect('text' in content, uri).toBe(true);
      if (!('text' in content)) continue;
      const payload = JSON.parse(content.text) as { id?: string };
      expect(payload.id, uri).toBe(id);
    }
  });

  for (const id of PROMPT_IDS) {
    it(`renders interpret_${id} from every declared branch vector`, async () => {
      const client = await connectTestClient(`catalog-prompt-${id}-test`);
      const spec = loadSpec(id);
      const promptCases = loadAuthoritativeReferenceCases(id).filter((testCase) =>
        Object.entries(spec.inputs).every(([name, input]) =>
          testCase.inputs[name] !== undefined || input.default !== undefined || !input.required));
      expect(promptCases.length, `${id}: source-derived prompt cases`).toBeGreaterThan(0);
      for (const [index, vector] of promptCases.entries()) {
        const args: Record<string, string> = {};

        for (const [name, input] of Object.entries(spec.inputs)) {
          const raw = vector.inputs[name] ?? input.default;
          if (raw === undefined) {
            expect(input.required, `${id}.${name} has no prompt fixture`).toBe(false);
            continue;
          }
          args[name] = promptArgument(input, raw);
        }

        const rendered = await client.getPrompt({
          name: `interpret_${id}`,
          arguments: args,
        });
        expect(rendered.messages).toHaveLength(1);
        const message = rendered.messages[0];
        expect(message.role).toBe('user');
        expect(message.content.type).toBe('text');
        if (message.content.type !== 'text') continue;
        expect(message.content.text.length).toBeGreaterThan(100);
        expect(message.content.text).not.toMatch(/\{\{[^}]+\}\}/);
        expect(message.content.text).not.toContain('[object Object]');
        if (index === 0 && id === 'abg') {
          expect(message.content.text).toContain('without adding a diagnosis');
          expect(message.content.text).toContain('Expected PaCO2 range:');
          expect(message.content.text).toContain('Compensation status:');
          expect(message.content.text).toContain('Delta ratio:');
          expect(message.content.text).toContain('Albumin-corrected delta ratio:');
          expect(message.content.text).toContain('Mixed-disorder branch IDs: []');
        }
        if (index === 0 && id === 'csf') {
          expect(message.content.text).toContain('Do not name a most-likely diagnosis');
          expect(message.content.text).toContain('Confirmed assay reports: [');
        }
        if (index === 0 && id === 'hepb') {
          expect(message.content.text).toContain('without adding treatment, prognosis, disease phase, or an infectivity level');
          expect(message.content.text).toContain('Pattern code: acute_infection_pattern');
        }
      }
    });
  }

  it('renders every deterministic ABG branch and the hepatitis window branch', async () => {
    const client = await connectTestClient('catalog-prompt-reference-branches-test');
    const abgBranches = [
      [{ ph: 7.4, paco2: 40, bicarbonate: 24 }, 'within_arterial_reference'],
      [{ ph: 7.3, paco2: 30, bicarbonate: 16 }, 'metabolic_acidemia'],
      [{ ph: 7.3, paco2: 55, bicarbonate: 24 }, 'respiratory_acidemia'],
      [{ ph: 7.3, paco2: 55, bicarbonate: 16 }, 'mixed_acidemia'],
      [{ ph: 7.5, paco2: 45, bicarbonate: 34 }, 'metabolic_alkalemia'],
      [{ ph: 7.5, paco2: 25, bicarbonate: 24 }, 'respiratory_alkalemia'],
      [{ ph: 7.5, paco2: 25, bicarbonate: 34 }, 'mixed_alkalemia'],
      [{ ph: 7.4, paco2: 30, bicarbonate: 20 }, 'compensated_or_mixed_low_values'],
      [{ ph: 7.4, paco2: 50, bicarbonate: 30 }, 'compensated_or_mixed_high_values'],
      [{ ph: 7.4, paco2: 40, bicarbonate: 28 }, 'indeterminate_arterial_pattern'],
      [{ ph: 7.3, paco2: 40, bicarbonate: 18, sample_type: 'peripheral_venous' }, 'screening_only_venous'],
    ] as const;
    for (const [bloodGas, branch] of abgBranches) {
      const rendered = await client.getPrompt({
        name: 'interpret_abg',
        arguments: Object.fromEntries(Object.entries({
          ...bloodGas,
          sodium: 140,
          chloride: 104,
        }).map(([name, value]) => [name, String(value)])),
      });
      const content = rendered.messages[0]?.content;
      expect(content?.type, branch).toBe('text');
      if (content?.type === 'text') {
        expect(content.text, branch).toContain(`Acid-base branch: ${branch}`);
        if (branch === 'within_arterial_reference') {
          expect(content.text).toContain('Expected PaCO2 range: not available for this result');
          expect(content.text).toContain('Delta ratio: not available for this result');
        }
        if (branch === 'metabolic_acidemia') {
          expect(content.text).not.toContain('Expected PaCO2 range: not available for this result');
          expect(content.text).not.toContain('Compensation status: not available for this result');
        }
      }
    }

    const windowPattern = await client.getPrompt({
      name: 'interpret_hepb',
      arguments: {
        hbsag: 'negative', anti_hbc: 'positive', anti_hbs: 'negative', igm_anti_hbc: 'positive',
      },
    });
    const content = windowPattern.messages[0]?.content;
    expect(content?.type).toBe('text');
    if (content?.type === 'text') expect(content.text).toContain('Pattern code: resolving_or_window_pattern');
  });

  it('rejects blank/bad prompt values as invalid params and completes closed choices', async () => {
    const client = await connectTestClient('catalog-prompt-validation-test');
    await expectInvalidPromptArguments(client.getPrompt({
      name: 'interpret_abg',
      arguments: {
        ph: ' ', paco2: '40', bicarbonate: '24', sodium: '140', chloride: '104',
      },
    }));
    await expectInvalidPromptArguments(client.getPrompt({
      name: 'interpret_abg',
      arguments: {
        ph: 'not-a-number', paco2: '40', bicarbonate: '24', sodium: '140', chloride: '104',
      },
    }));
    await expectInvalidPromptArguments(client.getPrompt({
      name: 'interpret_abg',
      arguments: {
        ph: '7.4', paco2: '40', bicarbonate: '24', sodium: '140', chloride: '104', venous_sample: 'maybe',
      },
    }));
    await expectInvalidPromptArguments(client.getPrompt({
      name: 'interpret_hepb',
      arguments: { hbsag: 'maybe', anti_hbc_total: 'negative', anti_hbs: 'negative' },
    }));

    const completion = await client.complete({
      ref: { type: 'ref/prompt', name: 'interpret_abg' },
      argument: { name: 'sample_type', value: 'peri' },
    });
    expect(completion.completion.values).toEqual(['peripheral_venous']);

    const booleanCompletion = await client.complete({
      ref: { type: 'ref/prompt', name: 'interpret_abg' },
      argument: { name: 'venous_sample', value: 't' },
    });
    expect(booleanCompletion.completion.values).toEqual(['true']);
  });
});
