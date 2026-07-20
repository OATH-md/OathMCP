/**
 * Integration coverage for the agent-native surface — the pieces the
 * golden/property suites don't reach because they drive the engine
 * directly and bypass the MCP layer: `calculate_panel`'s batch semantics and the
 * per-spec evidence resources. Exercised through a real in-memory MCP client so a
 * future schema or handler change can't silently break them.
 */
import { describe, expect, it } from 'vitest';
import { loadSpec } from '../engine/index.js';
import { connectTestClient } from '../../test/support/mcp-client.js';
import { selectPanelInputs } from './build-tools.js';

interface PanelEntry {
  calculator: string;
  ok: boolean;
  result?: { results: { name: string; value: number }[] };
  error?: {
    code: string;
    error: string;
    field: string;
    expected: string;
    allowed?: string[];
    min?: number;
    max?: number;
  };
}

describe('calculate_panel', () => {
  it('rejects empty/duplicate lists and handles the exact maximum deterministically', async () => {
    const client = await connectTestClient('agent-tools-panel-limits-test');
    const empty = await client.callTool({
      name: 'calculate_panel',
      arguments: { calculators: [], inputs: {} },
    });
    expect(empty.isError).toBe(true);
    expect(JSON.stringify(empty.content)).toMatch(/at least|too_small|invalid/i);

    const fifty = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: Array.from({ length: 50 }, (_, index) => `unknown_${index}`),
        inputs: {},
      },
    });
    expect((fifty.structuredContent as { results: PanelEntry[] }).results).toHaveLength(50);

    const oversized = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: Array.from({ length: 51 }, (_, index) => `unknown_${index}`),
        inputs: {},
      },
    });
    expect(oversized.isError).toBe(true);
    expect(JSON.stringify(oversized.content)).toMatch(/50|too_big|invalid/i);
  });

  it('rejects unknown override keys and does not mutate caller-owned input bags', async () => {
    const client = await connectTestClient('agent-tools-panel-overrides-test');
    const result = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: ['bmi'],
        inputs: {},
        overrides: {
          bmi: { weight_kg: 70, height_cm: 170 },
          invented: { value: 1 },
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [],
      error: { code: 'UNKNOWN_CALCULATOR', field: 'overrides.invented' },
    });
    expect(JSON.stringify(result.content)).toContain('overrides.invented');

    const unrequested = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: ['bmi'],
        inputs: {},
        overrides: {
          bmi: { weight_kg: 70, height_cm: 170 },
          gfr: { creatinine: 1, age: 40, sex: 'male' },
        },
      },
    });
    expect(unrequested.isError).toBe(true);
    expect(unrequested.structuredContent).toMatchObject({
      results: [],
      error: { code: 'UNKNOWN_INPUT', field: 'overrides.gfr' },
    });

    const shared = { weight_kg: 70 };
    const overrides = { height_cm: 170 };
    const selected = selectPanelInputs(loadSpec('bmi'), shared, overrides);
    selected.weight_kg = 90;
    selected.height_cm = 190;
    expect(shared).toEqual({ weight_kg: 70 });
    expect(overrides).toEqual({ height_cm: 170 });
  });

  it('never shares role-specific APGAR, CSF, or PEWS collision fields', () => {
    const shared = { appearance: 'abnormal', respiratory: 'abnormal' };
    for (const id of ['apgar', 'csf', 'pews']) {
      expect(selectPanelInputs(loadSpec(id), shared, {})).toEqual({});
    }
  });

  it('runs each calculator against shared inputs and isolates a bad id from the batch', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: ['gfr', 'meld', 'not_a_calculator'],
        inputs: {},
        overrides: {
          gfr: { creatinine: 1.2, age: 55, sex: 'male' },
          meld: {
            creatinine: 1.2, age: 55, sex: 'male', bilirubin: 2,
            inr: 1.5, sodium: 135, albumin: 3.2, dialysis: false,
          },
        },
      },
    });

    // A single failing calculator must never fail the whole batch.
    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as { results: PanelEntry[] };
    expect(results).toHaveLength(3);

    const gfr = results.find((r) => r.calculator === 'gfr');
    expect(gfr?.ok).toBe(true);
    expect(gfr?.result?.results[0].value).toBeCloseTo(71.42, 2);

    const meld = results.find((r) => r.calculator === 'meld');
    expect(meld?.ok).toBe(true);

    const bad = results.find((r) => r.calculator === 'not_a_calculator');
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toMatchObject({
      code: 'UNKNOWN_CALCULATOR',
      field: 'id',
    });
  });

  it('captures a per-calculator input error inline, satisfying the pinned error schema', async () => {
    const client = await connectTestClient('agent-tools-test');
    // The SDK validates structuredContent against the pinned outputSchema on
    // every call — a malformed error entry would make this call itself fail.
    const result = await client.callTool({
      name: 'calculate_panel',
      // gfr gets a valid creatinine; bmi is missing its required height/weight.
      arguments: {
        calculators: ['gfr', 'bmi'],
        inputs: {},
        overrides: { gfr: { creatinine: 1.2, age: 55, sex: 'male' } },
      },
    });

    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as { results: PanelEntry[] };
    expect(results.find((r) => r.calculator === 'gfr')?.ok).toBe(true);
    const bmi = results.find((r) => r.calculator === 'bmi');
    expect(bmi?.ok).toBe(false);
    expect(typeof bmi?.error?.error).toBe('string');
    expect(typeof bmi?.error?.field).toBe('string');
    expect(typeof bmi?.error?.expected).toBe('string');
  });

  it('rejects duplicate calculator ids instead of silently changing cardinality', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: ['gfr', 'gfr', 'bmi', 'gfr'],
        inputs: { creatinine: 1.2, age: 55, sex: 'male', weight: 80, height_cm: 180 },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [],
      error: {
        code: 'CONSTRAINT_FAILED',
        field: 'calculators[1]',
        expected: 'unique calculator ids',
      },
    });
    expect(JSON.stringify(result.content)).toContain("Duplicate calculator 'gfr'");
  });

  it('merges per-calculator overrides over shared inputs without leaking them', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: ['bmi', 'bsa'],
        inputs: { weight_kg: 70, height_cm: 170 },
        overrides: { bsa: { weight_kg: 90 } },
      },
    });

    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as { results: PanelEntry[] };
    const bmi = results.find((entry) => entry.calculator === 'bmi');
    const bsa = results.find((entry) => entry.calculator === 'bsa');
    expect(bmi?.result?.results[0].value).toBeCloseTo(24.22, 2);
    expect(bsa?.result?.results[0].value).toBeCloseTo(2.06, 2);
  });

  it('isolates shared canonical values from another calculator\'s aliases', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: ['meld', 'child_pugh'],
        inputs: {},
        overrides: {
          meld: {
            creatinine: 1.2, bilirubin: 2, inr: 1.5, sodium: 135,
            albumin: 3.2, age: 55, sex: 'male', dialysis: false,
          },
          child_pugh: {
            bilirubin_category: 'moderate',
            albumin_category: 'moderate',
            inr_category: 'moderate',
            ascites: 'none',
            encephalopathy: 'none',
          },
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as { results: PanelEntry[] };
    expect(results.find((entry) => entry.calculator === 'meld')?.ok).toBe(true);
    expect(results.find((entry) => entry.calculator === 'child_pugh')?.ok).toBe(true);
  });

  it('rejects patient-scoped shared keys rather than binding them to KDPI donor fields', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: ['kdpi'],
        inputs: { age: 55, height_cm: 175, weight_kg: 80 },
        overrides: {
          kdpi: {
            donor_hypertension: false, donor_diabetes: false, cause_of_death_cva: false,
            donor_creatinine: 1, donation_after_circulatory_death: false,
          },
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [],
      error: { code: 'UNKNOWN_INPUT', field: 'inputs.age' },
    });
  });

  it('returns stable error codes and hard-limit details inline', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'calculate_panel',
      arguments: {
        calculators: ['gfr'],
        inputs: {},
        overrides: { gfr: { creatinine: 115, age: 55, sex: 'male' } },
      },
    });

    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as { results: PanelEntry[] };
    const [min, max] = loadSpec('gfr').inputs.creatinine.hardLimits ?? [];
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatchObject({
      code: 'OUT_OF_HARD_LIMITS',
      field: 'creatinine',
      min,
      max,
    });
  });

});

describe('catalog dispatch tools', () => {
  it('ranks atrial-fibrillation language to CHA2DS2-VASc', async () => {
    const client = await connectTestClient('agent-tools-test');
    for (const query of ['afib stroke risk', 'AF stroke risk']) {
      const result = await client.callTool({
        name: 'find_calculator',
        arguments: { query },
      });
      const { matches } = result.structuredContent as {
        matches: { id: string }[];
      };
      expect(matches[0]?.id, query).toBe('chadsvasc');
    }
  });

  it('describes one calculator from its canonical spec', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'describe_calculator',
      arguments: { id: 'map' },
    });

    expect(result.isError).toBeFalsy();
    const { calculator } = result.structuredContent as {
      calculator: {
        id: string;
        version: string;
        inputs: Record<string, { aliases?: string[] }>;
        outputs: Record<string, unknown>;
      };
    };
    expect(calculator.id).toBe('map');
    expect(calculator.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(calculator.inputs)).toEqual([
      'systolic_bp',
      'diastolic_bp',
    ]);
    expect(calculator.inputs.systolic_bp.aliases).toContain('systolic');
    expect(calculator.outputs).toHaveProperty('map');
  });

  it('returns a machine-readable error for an unknown calculator description', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'describe_calculator',
      arguments: { id: 'not_a_calculator' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'UNKNOWN_CALCULATOR',
        field: 'id',
      },
    });
  });

  it('offers only dispatch tools in compact catalog mode', async () => {
    const client = await connectTestClient('compact-agent-tools-test', {
      mode: 'compact',
    });
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'calculate',
      'calculate_panel',
      'describe_calculator',
      'find_calculator',
    ]);
    expect(Buffer.byteLength(JSON.stringify({ tools }))).toBeLessThanOrEqual(32 * 1024);
    for (const name of ['calculate', 'calculate_panel']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(Buffer.byteLength(JSON.stringify(tool)), name).toBeLessThanOrEqual(12 * 1024);
    }
    const { resources } = await client.listResources();
    expect(resources.some((resource) => resource.uri === 'calc://gfr/evidence')).toBe(true);
  });

  it('runs the typed compact dispatcher with direct-tool parity and inline errors', async () => {
    const compact = await connectTestClient('compact-calculate-test', { mode: 'compact' });
    const success = await compact.callTool({
      name: 'calculate',
      arguments: { id: 'map', inputs: { systolic_bp: 120, diastolic_bp: 80 } },
    });
    const successEntry = (success.structuredContent as {
      result: PanelEntry;
    }).result;
    expect(successEntry).toMatchObject({ calculator: 'map', ok: true });
    expect(successEntry.result?.results[0].value).toBeCloseTo(93.33, 2);
    expect(success.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'resource_link', uri: 'calc://map/evidence' }),
    ]));

    const failure = await compact.callTool({
      name: 'calculate',
      arguments: { id: 'map', inputs: { systolic_bp: 80, diastolic_bp: 80 } },
    });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toMatchObject({
      result: { calculator: 'map', ok: false, error: { code: 'CONSTRAINT_FAILED' } },
    });

    const unknownInput = await compact.callTool({
      name: 'calculate',
      arguments: { id: 'map', inputs: { systolic_bp: 120, diastolic_bp: 80, patient_name: 'private' } },
    });
    expect(unknownInput.structuredContent).toMatchObject({
      result: {
        calculator: 'map',
        ok: false,
        error: {
          code: 'UNKNOWN_INPUT',
          field: 'patient_name',
          allowed: expect.arrayContaining(['systolic_bp', 'diastolic_bp']),
        },
      },
    });

    const missing = await compact.callTool({
      name: 'calculate',
      arguments: { id: 'map', inputs: { systolic_bp: 120 } },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({
      result: {
        calculator: 'map', ok: false,
        error: { code: 'MISSING_REQUIRED', field: 'diastolic_bp' },
      },
    });

    const badUnit = await compact.callTool({
      name: 'calculate',
      arguments: {
        id: 'gfr',
        inputs: { creatinine: { value: 88.4, unit: 'bananas' }, age: 50, sex: 'male' },
      },
    });
    expect(badUnit.isError).toBe(true);
    expect(badUnit.structuredContent).toMatchObject({
      result: {
        calculator: 'gfr', ok: false,
        error: { code: 'UNKNOWN_UNIT', field: 'creatinine', allowed: ['mg/dL', 'umol/L'] },
      },
    });

    const unknownCalculator = await compact.callTool({
      name: 'calculate',
      arguments: { id: 'not_a_calculator', inputs: {} },
    });
    expect(unknownCalculator.isError).toBe(true);
    expect(unknownCalculator.structuredContent).toMatchObject({
      result: {
        calculator: 'not_a_calculator',
        ok: false,
        error: {
          code: 'UNKNOWN_CALCULATOR',
          field: 'id',
          expected: 'a canonical id returned by find_calculator',
        },
      },
    });
  });
});

describe('conditional outputs through the MCP layer', () => {
  it('returns a valid structured OSI result for a spo2-only oxygenation_index call', async () => {
    const client = await connectTestClient('agent-tools-test');
    const result = await client.callTool({
      name: 'calculate_oxygenation_index',
      arguments: { spo2: 92, fio2: 60, mean_airway_pressure: 15 },
    });

    // This guards against emitting { value: undefined } for the absent oi output,
    // which fails the SDK's structuredContent validation.
    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as {
      results: { name: string; value: number }[];
    };
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('osi');
    expect(results[0].value).toBeCloseTo(9.78, 2);
  });
});

describe('evidence resources', () => {
  it('lists an evidence resource per calculator', async () => {
    const client = await connectTestClient('agent-tools-test');
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === 'calc://gfr/evidence')).toBe(true);
  });

  it('serves citations and interpretation bands as JSON', async () => {
    const client = await connectTestClient('agent-tools-test');
    const read = await client.readResource({ uri: 'calc://gfr/evidence' });
    const content = read.contents[0] as { mimeType?: string; text: string };
    expect(content.mimeType).toBe('application/json');
    const payload = JSON.parse(content.text) as {
      id: string;
      evidence: unknown[];
      interpretationBands: unknown[];
    };
    expect(payload.id).toBe('gfr');
    expect(payload.evidence.length).toBeGreaterThan(0);
    expect(payload.interpretationBands.length).toBeGreaterThan(0);
  });

  it('serves output-specific interpretation bands', async () => {
    const client = await connectTestClient('agent-tools-test');
    const read = await client.readResource({ uri: 'calc://oxygenation_index/evidence' });
    const content = read.contents[0] as { text: string };
    const payload = JSON.parse(content.text) as {
      outputs: Record<string, { interpretationBands: unknown[] }>;
    };
    expect(payload.outputs.oi.interpretationBands.length).toBeGreaterThan(0);
    expect(payload.outputs.osi.interpretationBands).toEqual([]);
  });
});
