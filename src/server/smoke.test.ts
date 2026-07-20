import { describe, expect, it } from 'vitest';
import { connectTestClient } from '../../test/support/mcp-client.js';

describe('MCP server smoke test', () => {
  it('lists calculate_gfr with derived schemas and read-only annotations', async () => {
    const client = await connectTestClient('smoke-test');
    const { tools } = await client.listTools();

    const gfr = tools.find((t) => t.name === 'calculate_gfr');
    expect(gfr).toBeDefined();
    expect(gfr?.description).toContain('Do NOT use when:');
    expect(gfr?.inputSchema.properties).toHaveProperty('creatinine');
    expect(gfr?.inputSchema.properties).toHaveProperty('age');
    expect(gfr?.inputSchema.properties).toHaveProperty('sex');
    expect(gfr?.inputSchema.required).toEqual(
      expect.arrayContaining(['creatinine', 'age', 'sex']),
    );
    const ageSchema = gfr?.inputSchema.properties?.age as
      | { minimum?: number; maximum?: number }
      | undefined;
    expect(ageSchema?.minimum).toBe(18);
    expect(ageSchema?.maximum).toBe(120);
    expect(gfr?.outputSchema?.properties).toHaveProperty('results');
    expect(gfr?.annotations?.readOnlyHint).toBe(true);
    expect(gfr?.annotations?.idempotentHint).toBe(true);
    expect(gfr?.annotations?.openWorldHint).toBe(false);
  });

  it('returns structuredContent with the computed value for a known input', async () => {
    const client = await connectTestClient('smoke-test');
    const result = await client.callTool({
      name: 'calculate_gfr',
      arguments: { creatinine: 1.2, age: 55, sex: 'male' },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      schemaVersion: string;
      results: { name: string; value: number; unit?: string }[];
      interpretation?: { label: string; severity: string };
    };
    expect(structured.schemaVersion).toBe('1.1');
    expect(structured.results[0].name).toBe('gfr');
    expect(structured.results[0].value).toBeCloseTo(71.42, 2);
    expect(structured.interpretation?.severity).toBe('borderline');
  });

  it('accepts SI quantity input via { value, unit }', async () => {
    const client = await connectTestClient('smoke-test');
    const result = await client.callTool({
      name: 'calculate_gfr',
      arguments: { creatinine: { value: 106, unit: 'umol/L' }, age: 55, sex: 'male' },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: { value: number }[] };
    expect(structured.results[0].value).toBeCloseTo(71.48, 2);
  });

  it('accepts compatibility aliases while identifying them as noncanonical inputs', async () => {
    const client = await connectTestClient('smoke-test');
    const { tools } = await client.listTools();
    const map = tools.find((tool) => tool.name === 'calculate_map');
    expect(map?.inputSchema.properties).toHaveProperty('systolic');
    expect(map?.inputSchema.properties).toHaveProperty('diastolic');
    expect(JSON.stringify(map?.inputSchema.properties?.systolic)).toContain('Compatibility alias');

    const result = await client.callTool({
      name: 'calculate_map',
      arguments: { systolic: 120, diastolic: 80 },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      results: { value: number }[];
      warnings: string[];
    };
    expect(structured.results[0].value).toBeCloseTo(93.33, 2);
    expect(structured.warnings).toEqual([
      "Input 'systolic' is a compatibility alias; use 'systolic_bp'.",
      "Input 'diastolic' is a compatibility alias; use 'diastolic_bp'.",
    ]);
  });

  it('defers enum aliases and normalized unit spellings to the engine', async () => {
    const client = await connectTestClient('smoke-test');
    const enumResult = await client.callTool({
      name: 'calculate_free_water_deficit',
      arguments: {
        weight_kg: 70,
        current_sodium: 154,
        ideal_sodium: 140,
        demographic: 'Adult Male (18-65 years)',
      },
    });
    expect(enumResult.isError).toBeFalsy();

    const unitResult = await client.callTool({
      name: 'calculate_gfr',
      arguments: {
        creatinine: { value: 106, unit: 'µmol / L' },
        age: 55,
        sex: 'male',
      },
    });
    expect(unitResult.isError).toBeFalsy();
    const structured = unitResult.structuredContent as { results: { value: number }[] };
    expect(structured.results[0].value).toBeCloseTo(71.48, 2);
  });

  it('rejects inputs outside the published schema at the SDK boundary', async () => {
    const client = await connectTestClient('smoke-test');

    const missing = await client.callTool({
      name: 'calculate_gfr',
      arguments: { creatinine: 1.2, age: 55 },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/-32602|Invalid arguments/i);

    const badEnum = await client.callTool({
      name: 'calculate_gfr',
      arguments: { creatinine: 1.2, age: 55, sex: 'unknown' },
    });
    expect(badEnum.isError).toBe(true);
    expect(JSON.stringify(badEnum.content)).toMatch(/-32602|Invalid arguments/i);

    const hardLimit = await client.callTool({
      name: 'calculate_gfr',
      arguments: { creatinine: 100, age: 55, sex: 'male' },
    });
    expect(hardLimit.isError).toBe(true);
    expect(JSON.stringify(hardLimit.content)).toMatch(/-32602|Invalid arguments/i);
  });

  it('rejects a direct-tool typo instead of stripping it', async () => {
    const client = await connectTestClient('smoke-test');
    const result = await client.callTool({
      name: 'calculate_gfr',
      arguments: { creatnine: 1.2, creatinine: 1.2, age: 55, sex: 'male' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/creatnine|unrecognized/i);
  });

  it('relays engine errors as isError with a machine-readable payload', async () => {
    const client = await connectTestClient('smoke-test');
    const result = await client.callTool({
      name: 'calculate_map',
      arguments: { systolic_bp: 80, diastolic_bp: 80 },
    });

    expect(result.isError).toBe(true);
    const [first] = result.content as { type: string; text: string }[];
    const payload = JSON.parse(first.text) as {
      code: string;
      error: string;
      field: string;
      expected: string;
      min?: number;
      max?: number;
    };
    expect(payload.code).toBe('CONSTRAINT_FAILED');
    expect(payload.field).toBe('systolic_bp');
    expect(payload.error).toContain('greater than diastolic');
    expect(payload.expected).toBe('systolic_bp > diastolic_bp');
    expect(payload.min).toBeUndefined();
    expect(payload.max).toBeUndefined();
  });
});
