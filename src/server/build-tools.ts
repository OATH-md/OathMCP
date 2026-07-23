/**
 * MCP server assembly: derives one `calculate_<id>` tool per loaded spec — no
 * hand-written per-calculator definitions. All MCP-SDK imports stay confined to
 * `src/server/**` so the protocol boundary remains contained.
 *
 * The SDK validates `structuredContent` against `outputSchema` on every call,
 * and our handlers return the engine's full `CalcResult` envelope — so the
 * derived output schema describes that envelope, with `results[].name`
 * constrained to the spec's declared outputs.
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import * as z from 'zod/v4';
import { fillTemplate as fillPromptTemplate } from '../engine/prompt-template.js';
import {
  run,
  loadSpecs,
  assertComputeCoverage,
  getRegisteredComputeIds,
  assertOutputConditionCoverage,
  EngineError,
  InputError,
  type CalcSpec,
  type InputSpec,
} from '../engine/index.js';
import {
  buildCalculatorDescriptor,
  buildCalculatorInputSchema,
  buildCalcResultSchema,
  buildCompactDispatchResultSchema,
  buildPanelResultSchema,
  calculatorDescriptorSchema,
  errorPayloadSchema,
  recoverableToolErrorSchema,
} from './public-contract.js';
import { RESPONSIBLE_USE_TEXT } from './responsible-use.generated.js';
import { createCalculatorSearch } from './calculator-search.js';

function resolveVersion(): string {
  return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
}

function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}

/**
 * Coerce a prompt argument (MCP prompt args are always strings) to the value
 * kind the engine expects. Numbers stay as `Number(v)` and let `run()` reject a
 * NaN with a typed InputError; booleans accept the common truthy/falsy spellings.
 * Quantities take the bare canonical number (the `{value,unit}` object form is a
 * tool-only convenience).
 */
function coercePromptArg(input: InputSpec, raw: string): unknown {
  switch (input.kind) {
    case 'number':
    case 'integer':
    case 'quantity':
      // Reject a blank/whitespace string explicitly: `Number('')` is 0, which
      // would sail past `run()`'s NaN check and compute on a silent zero.
      if (raw.trim() === '') {
        throw new InputError({
          field: '(prompt arg)',
          message: `${input.title} must be a number but received an empty string.`,
          expected: input.kind,
        });
      }
      return Number(raw);
    case 'boolean':
      if (/^(true|1|yes)$/i.test(raw)) return true;
      if (/^(false|0|no)$/i.test(raw)) return false;
      throw new InputError({
        field: '(prompt arg)',
        message: `Expected a boolean (true/false) but received '${raw}'.`,
        expected: 'true | false',
      });
    case 'enum':
      return raw;
  }
}

function promptArgDescription(input: InputSpec): string {
  switch (input.kind) {
    case 'quantity':
      return `${input.description} Provide a numeric string in the canonical unit ${input.quantity.canonicalUnit}.`;
    case 'number':
    case 'integer':
      return `${input.description} Provide a numeric string.`;
    case 'boolean':
      return `${input.description} Use true or false.`;
    case 'enum':
      return `${input.description} Choose one of: ${input.enumValues.map((option) => option.value).join(', ')}.`;
  }
}

function promptStringSchema(input: InputSpec): z.ZodType<string> {
  switch (input.kind) {
    case 'number':
    case 'quantity':
      return z.string().trim().min(1).refine((value) => Number.isFinite(Number(value)), 'Expected a finite numeric string');
    case 'integer':
      return z.string().trim().min(1).refine((value) => Number.isInteger(Number(value)), 'Expected an integer string');
    case 'boolean':
      return z.enum(['true', 'false', '1', '0', 'yes', 'no']);
    case 'enum':
      return z.enum(input.enumValues.map((option) => option.value) as [string, ...string[]]);
  }
}

/** Prompt argument schema: MCP prompt args are strict string-only contracts. */
function promptArgsShape(spec: CalcSpec): Record<string, z.ZodType> {
  return Object.fromEntries(
    Object.entries(spec.inputs).map(([name, input]) => {
      let field: z.ZodType = promptStringSchema(input);
      if (!input.required) field = field.optional();
      field = field.describe(promptArgDescription(input));
      if (input.kind === 'boolean' || input.kind === 'enum') {
        const choices = input.kind === 'boolean'
          ? ['true', 'false']
          : input.enumValues.map((option) => option.value);
        field = completable(field, (value) => {
          const prefix = String(value ?? '').toLowerCase();
          return choices.filter((choice) => choice.toLowerCase().startsWith(prefix));
        });
      }
      return [name, field];
    }),
  );
}

/** Substitute prompt placeholders from the computed inputs and outputs. */
function fillTemplate(template: string, result: ReturnType<typeof run>): string {
  const values: Record<string, string> = {};
  const serialize = (value: unknown): string =>
    value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
  for (const [name, used] of Object.entries(result.inputsUsed)) {
    values[name] = serialize(used.value);
  }
  for (const r of result.results) {
    values[r.name] = serialize(r.value);
  }
  return fillPromptTemplate(template, values);
}

interface PromptDefinition {
  name: string;
  config: { title: string; description: string; argsSchema: Record<string, z.ZodType> };
  // The SDK infers the arg values as `unknown` from the wide raw-shape type; each
  // is a validated string (or absent) at runtime — narrowed in the handler.
  handler: (args: Record<string, unknown>) => {
    messages: { role: 'user'; content: { type: 'text'; text: string } }[];
  };
}

/**
 * Derive an `interpret_<id>` MCP prompt for a spec carrying a `prompt` block.
 * The handler runs the deterministic calculator, injects the computed values
 * into the template, and hands the narrative task to the host LLM — no server-
 * side model call.
 */
function buildPromptDefinition(spec: CalcSpec): PromptDefinition {
  const prompt = spec.prompt;
  if (prompt === undefined) {
    throw new Error(`spec '${spec.id}': buildPromptDefinition called without a prompt block.`);
  }
  return {
    name: `interpret_${spec.id}`,
    config: {
      title: `Interpret ${spec.name}`,
      description: prompt.description,
      argsSchema: promptArgsShape(spec),
    },
    handler: (args) => {
      const rawInputs: Record<string, unknown> = {};
      for (const [name, input] of Object.entries(spec.inputs)) {
        const value = args[name] as string | undefined;
        if (value !== undefined) {
          rawInputs[name] = coercePromptArg(input, value);
        }
      }
      const result = run(spec.id, rawInputs);
      return {
        messages: [
          { role: 'user', content: { type: 'text', text: fillTemplate(prompt.template, result) } },
        ],
      };
    },
  };
}

// A type alias (not an interface) so it keeps the implicit index signature the
// SDK's CallToolResult parameter requires.
type ToolResult = {
  content: (
    | { type: 'text'; text: string }
    | { type: 'resource_link'; uri: string; name: string; description: string; mimeType: string }
  )[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

interface ToolDefinition {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodObject;
    outputSchema: z.ZodObject;
    annotations: {
      title: string;
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    };
  };
  handler: (args: Record<string, unknown>) => ToolResult;
}

function buildToolDefinition(spec: CalcSpec): ToolDefinition {
  const description =
    spec.purposeForAgents + (spec.whenNotToUse ? `\nDo NOT use when: ${spec.whenNotToUse}` : '');

  return {
    name: `calculate_${spec.id}`,
    config: {
      title: spec.name,
      description,
      inputSchema: buildCalculatorInputSchema(spec),
      outputSchema: buildCalcResultSchema(spec),
      annotations: readOnlyAnnotations(spec.name),
    },
    handler: (args) => {
      try {
        const result = {
          ...run(spec.id, args),
          evidenceUri: `calc://${spec.id}/evidence`,
        };
        return jsonResult(result as unknown as Record<string, unknown>, spec);
      } catch (e) {
        if (isEngineError(e)) {
          // Returned (not thrown) so the calling agent can read the payload
          // and self-correct — e.g. re-send creatinine as { value, unit }.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(e)) }],
          };
        }
        throw e;
      }
    },
  };
}

/**
 * Machine-readable error payload an agent can act on — one uniform shape across
 * every tool. A typed engine error keeps its field/expected hints; anything else
 * degrades to the message with empty hints (used by the panel's catch-all).
 */
function errorPayload(e: unknown): z.infer<typeof errorPayloadSchema> {
  if (isEngineError(e)) {
    return {
      code: e.code,
      error: e.message,
      field: e.field,
      expected: e.expected,
      ...(e.allowed !== undefined ? { allowed: e.allowed } : {}),
      ...(e.min !== undefined ? { min: e.min } : {}),
      ...(e.max !== undefined ? { max: e.max } : {}),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    error: e instanceof Error ? e.message : String(e),
    field: '',
    expected: '',
  };
}

/** Read-only calculator tool annotations — identical hint policy for every tool. */
function readOnlyAnnotations(title: string): ToolDefinition['config']['annotations'] {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/** A tool result carrying `payload` both as JSON text and as structuredContent. */
function jsonResult(
  payload: Record<string, unknown>,
  evidenceSpec?: CalcSpec,
  isError = false,
): ToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [
      { type: 'text' as const, text: JSON.stringify(payload) },
      ...(evidenceSpec === undefined ? [] : [{
        type: 'resource_link' as const,
        uri: `calc://${evidenceSpec.id}/evidence`,
        name: `${evidenceSpec.name} evidence`,
        description: `Citations, interpretation bands, and safety notes for ${evidenceSpec.name}.`,
        mimeType: 'application/json',
      }]),
    ],
    structuredContent: payload,
  };
}

/** Agent-first deterministic discovery; exclusion prose can only block selection. */
function buildFindCalculatorDefinition(specs: CalcSpec[]): ToolDefinition {
  const search = createCalculatorSearch(specs);
  return {
    name: 'find_calculator',
    config: {
      title: 'Find calculator',
      description:
        'Find calculators by clinical intent, population, model, or known name. Returns at most three relevant matches by default. If status is needs_clarification, do not calculate until the clarification is resolved.',
      inputSchema: z.strictObject({
        query: z.string().max(500).describe('Clinical intent, named calculator, population, or quantity to compute'),
        limit: z.number().int().min(1).max(10).optional()
          .describe('Maximum matches to return after relevance filtering; defaults to 3'),
      }),
      outputSchema: z.strictObject({
        status: z.enum(['matched', 'needs_clarification', 'no_match']),
        matches: z.array(
          z.strictObject({
            id: z.string(),
            name: z.string(),
            model: z.string(),
            variant: z.string().optional(),
            purposeForAgents: z.string(),
            applicability: z.strictObject({ population: z.string(), setting: z.string() }),
            limitations: z.array(z.string()),
            selection: z.enum(['candidate', 'needs_clarification']),
            matchReason: z.string(),
          }),
        ).max(10),
        noMatchReason: z.enum(['insufficient_intent', 'not_available', 'out_of_scope']).optional()
          .describe('Why no match was returned; present only when status is no_match'),
        clarificationQuestion: z.string().optional(),
      }),
      annotations: readOnlyAnnotations('Find calculator'),
    },
    handler: (args) => {
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      return jsonResult(search(String(args.query ?? ''), { limit }) as unknown as Record<string, unknown>);
    },
  };
}

function buildDescribeCalculatorDefinition(specs: CalcSpec[]): ToolDefinition {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const descriptors = new Map(specs.map((spec) => [spec.id, buildCalculatorDescriptor(spec)]));
  return {
    name: 'describe_calculator',
    config: {
      title: 'Describe calculator',
      description:
        'Return the declared inputs, outputs, evidence, safety limits, and version metadata for one calculator before running it.',
      inputSchema: z.strictObject({ id: z.string().describe('Calculator id without the calculate_ prefix') }),
      outputSchema: z.strictObject({
        calculator: calculatorDescriptorSchema.optional(),
        error: recoverableToolErrorSchema.optional(),
      }).superRefine((result, ctx) => {
        if ((result.calculator === undefined) === (result.error === undefined)) {
          ctx.addIssue({ code: 'custom', message: 'Expected calculator or error.' });
        }
      }),
      annotations: readOnlyAnnotations('Describe calculator'),
    },
    handler: (args) => {
      const id = String(args.id ?? '');
      const spec = byId.get(id);
      if (spec === undefined) {
        const error = new InputError({
          code: 'UNKNOWN_CALCULATOR',
          field: 'id',
          message: `Unknown calculator '${id}'. Call find_calculator for a canonical id.`,
          expected: 'a canonical id returned by find_calculator',
        });
        return jsonResult({ error: errorPayload(error) }, undefined, true);
      }
      return jsonResult({ calculator: descriptors.get(spec.id)! });
    },
  };
}

function buildCompactCalculateDefinition(specs: CalcSpec[]): ToolDefinition {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  return {
    name: 'calculate',
    config: {
      title: 'Calculate',
      description:
        'Run one known calculator. If the id or input contract is uncertain, call find_calculator then describe_calculator first. Never invent missing values; execution errors are actionable tool errors.',
      inputSchema: z.strictObject({
        id: z.string().trim().min(1).max(100)
          .describe('Canonical calculator id returned by find_calculator; omit the calculate_ prefix'),
        inputs: z.record(z.string(), z.unknown()),
      }),
      outputSchema: buildCompactDispatchResultSchema(),
      annotations: readOnlyAnnotations('Calculate'),
    },
    handler: (args) => {
      const id = String(args.id);
      const spec = byId.get(id);
      if (spec === undefined) {
        const error = new InputError({
          code: 'UNKNOWN_CALCULATOR',
          field: 'id',
          message: `Unknown calculator '${id}'. Call find_calculator for a canonical id.`,
          expected: 'a canonical id returned by find_calculator',
        });
        return jsonResult(
          { result: { calculator: id, ok: false, error: errorPayload(error) } },
          undefined,
          true,
        );
      }
      const inputs = (args.inputs as Record<string, unknown>) ?? {};
      try {
        const result = {
          ...run(id, inputs),
          evidenceUri: `calc://${id}/evidence`,
        };
        return jsonResult({ result: { calculator: id, ok: true, result } }, spec);
      } catch (error) {
        return jsonResult(
          { result: { calculator: id, ok: false, error: errorPayload(error) } },
          undefined,
          true,
        );
      }
    },
  };
}

/**
 * `calculate_panel`: reuse only explicitly shareable clinical concepts, then
 * layer calculator-specific overrides. One calculator failing never fails the
 * batch.
 */
export function selectPanelInputs(
  spec: CalcSpec,
  shared: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(spec.inputs)) {
    if (input.sharedKey === undefined) continue;
    if (shared[input.sharedKey] !== undefined) selected[name] = shared[input.sharedKey];
  }
  return { ...selected, ...overrides };
}

function buildPanelDefinition(specs: CalcSpec[]): ToolDefinition {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  return {
    name: 'calculate_panel',
    config: {
      title: 'Calculate panel',
      description:
        'Run one or more already-selected calculators; in compact mode prefer calculate for a single calculator. Shared inputs bind only to reviewed opt-in shared keys; put role-specific values in overrides. Duplicate ids, unused shared keys, and overrides for unrequested calculators are rejected. Calculator failures remain isolated per result.',
      inputSchema: z.strictObject({
        calculators: z
          .array(z.string().trim().min(1))
          .min(1)
          .max(50)
          .describe('Calculator ids to run, e.g. ["gfr","meld"] (omit the calculate_ prefix)'),
        inputs: z
          .record(z.string(), z.unknown())
          .describe('Values keyed by a reviewed sharedKey used by at least one requested calculator'),
        overrides: z
          .record(z.string(), z.record(z.string(), z.unknown()))
          .optional()
          .describe('Per-calculator inputs merged over the shared inputs'),
      }),
      outputSchema: buildPanelResultSchema(),
      annotations: readOnlyAnnotations('Calculate panel'),
    },
    handler: (args) => {
      const calculators = Array.isArray(args.calculators) ? (args.calculators as unknown[]) : [];
      const inputs = (args.inputs as Record<string, unknown>) ?? {};
      const overrides =
        (args.overrides as Record<string, Record<string, unknown>> | undefined) ?? {};
      const ids = calculators.map((raw) => String(raw));
      const seenIds = new Set<string>();
      const duplicateIndex = ids.findIndex((id) => {
        if (seenIds.has(id)) return true;
        seenIds.add(id);
        return false;
      });
      if (duplicateIndex !== -1) {
        const id = ids[duplicateIndex]!;
        const error = new InputError({
          code: 'CONSTRAINT_FAILED',
          field: `calculators[${duplicateIndex}]`,
          message: `Duplicate calculator '${id}'; request each calculator once.`,
          expected: 'unique calculator ids',
        });
        return jsonResult({ results: [], error: errorPayload(error) }, undefined, true);
      }
      const requested = new Set(ids);
      const unknownOverride = Object.keys(overrides).find((id) => !byId.has(id) || !requested.has(id));
      if (unknownOverride !== undefined) {
        const knownButUnrequested = byId.has(unknownOverride);
        const error = new InputError({
          code: knownButUnrequested ? 'UNKNOWN_INPUT' : 'UNKNOWN_CALCULATOR',
          message: knownButUnrequested
            ? `Override supplied for '${unknownOverride}', which is not in calculators.`
            : `Override supplied for unknown calculator '${unknownOverride}'.`,
          field: `overrides.${unknownOverride}`,
          expected: knownButUnrequested
            ? [...requested].join(' | ')
            : 'a canonical id returned by find_calculator',
        });
        return jsonResult({ results: [], error: errorPayload(error) }, undefined, true);
      }
      const acceptedSharedKeys = new Set(ids.flatMap((id) => {
        const spec = byId.get(id);
        return spec === undefined
          ? []
          : Object.values(spec.inputs).flatMap((input) => input.sharedKey === undefined ? [] : [input.sharedKey]);
      }));
      const unusedSharedKey = Object.keys(inputs).find((key) => !acceptedSharedKeys.has(key));
      if (unusedSharedKey !== undefined) {
        const allowed = [...acceptedSharedKeys].sort();
        const error = new InputError({
          code: 'UNKNOWN_INPUT',
          message: `Shared input '${unusedSharedKey}' is not used by any requested calculator.`,
          field: `inputs.${unusedSharedKey}`,
          expected: allowed.join(' | ') || 'no shared inputs; use overrides',
          allowed,
        });
        return jsonResult({ results: [], error: errorPayload(error) }, undefined, true);
      }
      const results = ids.map((id) => {
        try {
          const spec = byId.get(id);
          if (spec === undefined) throw new InputError({
            code: 'UNKNOWN_CALCULATOR', field: 'id',
            message: `Unknown calculator '${id}'. Call find_calculator for a canonical id.`,
            expected: 'a canonical id returned by find_calculator',
          });
          const calculatorOverrides = overrides[id] ?? {};
          const mergedInputs = selectPanelInputs(spec, inputs, calculatorOverrides);

          return {
            calculator: id,
            ok: true,
            result: {
              ...run(id, mergedInputs),
              evidenceUri: `calc://${id}/evidence`,
            },
          };
        } catch (e) {
          return { calculator: id, ok: false, error: errorPayload(e) };
        }
      });

      return jsonResult({ results });
    },
  };
}

interface ResourceDefinition {
  name: string;
  uri: string;
  config: { title: string; description: string; mimeType: string };
  read: () => { contents: { uri: string; mimeType: string; text: string }[] };
}

/**
 * Evidence resource for a spec: serves the citations, interpretation bands, and
 * safety notes as JSON at `calc://<id>/evidence`, so agents can pull the depth
 * behind a result on demand rather than carrying it in every tool response.
 */
function buildEvidenceResource(spec: CalcSpec): ResourceDefinition {
  const uri = `calc://${spec.id}/evidence`;
  const payload = {
    id: spec.id,
    name: spec.name,
    version: spec.version,
    whenNotToUse: spec.whenNotToUse,
    evidence: spec.evidence,
    interpretationBands: spec.interpretationBands ?? [],
    outputs: Object.fromEntries(
      Object.entries(spec.outputs).map(([name, output]) => [
        name,
        {
          ...output,
          interpretationBands: output.interpretationBands ?? [],
        },
      ]),
    ),
    warnings: spec.warnings ?? [],
  };
  const text = JSON.stringify(payload, null, 2);
  return {
    name: `evidence_${spec.id}`,
    uri,
    config: {
      title: `${spec.name} — evidence`,
      description: `Citations, interpretation bands, and safety notes for ${spec.name}.`,
      mimeType: 'application/json',
    },
    read: () => ({ contents: [{ uri, mimeType: 'application/json', text }] }),
  };
}

/** Canonical responsibility boundary, bundled for every transport and runtime. */
function buildResponsibleUseResource(): ResourceDefinition {
  const uri = 'oath://responsible-use';
  return {
    name: 'responsible_use',
    uri,
    config: {
      title: 'OathMCP — Responsible Use',
      description: 'Canonical clinical, deployment, privacy, warranty, and responsibility notice.',
      mimeType: 'text/markdown',
    },
    read: () => ({
      contents: [{ uri, mimeType: 'text/markdown', text: RESPONSIBLE_USE_TEXT }],
    }),
  };
}

// Specs are immutable after load. Shared definitions and each catalog profile
// are built lazily, then reused across fresh stateless server instances. A
// compact-only deployment therefore never pays to construct every direct schema.
interface SharedCatalogDefinitions {
  specs: CalcSpec[];
  tools: ToolDefinition[];
  prompts: PromptDefinition[];
  resources: ResourceDefinition[];
}
let sharedCatalogDefinitions: SharedCatalogDefinitions | null = null;
let directToolDefinitions: ToolDefinition[] | null = null;
let compactCalculateDefinition: ToolDefinition | null = null;

export type CatalogMode = 'full' | 'compact';

export interface BuildServerOptions {
  mode?: CatalogMode;
  version?: string;
}

export function catalogMode(value: string | undefined): CatalogMode {
  if (value === undefined || value === '' || value === 'full') return 'full';
  if (value === 'compact') return 'compact';
  throw new Error(`Invalid OATH_MCP_MODE '${value}'; expected 'full' or 'compact'.`);
}

/**
 * Build a fresh McpServer with one `calculate_<id>` tool per spec, the
 * `find_calculator` and `calculate_panel` agent-dispatch tools, an
 * `interpret_<id>` prompt for every spec that declares a `prompt` block, and an
 * `evidence_<id>` resource per spec.
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  // Materialize specs only when the shared cache is cold. On the warm
  // stateless-HTTP path, spec validation and derived contract work are skipped.
  if (sharedCatalogDefinitions === null) {
    const specs = [...loadSpecs().values()];
    assertComputeCoverage(
      specs.map((spec) => spec.id),
      getRegisteredComputeIds(),
    );
    assertOutputConditionCoverage(specs);
    sharedCatalogDefinitions = {
      specs,
      tools: [
        buildFindCalculatorDefinition(specs),
        buildDescribeCalculatorDefinition(specs),
        buildPanelDefinition(specs),
      ],
      prompts: specs.filter((s) => s.prompt !== undefined).map(buildPromptDefinition),
      resources: [...specs.map(buildEvidenceResource), buildResponsibleUseResource()],
    };
  }
  const { specs, tools: sharedTools, prompts, resources } = sharedCatalogDefinitions;
  const mode = options.mode ?? 'full';
  let selectedTools: ToolDefinition[];
  if (mode === 'compact') {
    compactCalculateDefinition ??= buildCompactCalculateDefinition(specs);
    selectedTools = [...sharedTools, compactCalculateDefinition];
  } else {
    directToolDefinitions ??= specs.map(buildToolDefinition);
    selectedTools = [...directToolDefinitions, ...sharedTools];
  }

  const server = new McpServer({
    name: 'oath-mcp',
    version: options.version ?? resolveVersion(),
  }, {
    instructions: [
      'OathMCP implements established clinical calculators for decision support, not new research, diagnosis, or treatment.',
      'Choose the exact population, clinical model, method, and variant. When the exact calculator is unknown, call find_calculator; ask for clarification if discovery returns needs_clarification and never silently choose.',
      `Call describe_calculator before first use or whenever inputs are uncertain, then ${mode === 'compact' ? 'call calculate' : 'call the matching calculate_<id> tool'}. Use calculate_panel only for multiple already-selected calculators.`,
      'Never invent missing inputs. Respect exclusions, units, warnings, adjustments, and stale-model notices. inputsUsed preserves normalized pre-adjustment values; when adjustments[].applied is true, adjustments[].effective is the value used for computation. Read the linked evidence resource when provenance or interpretation matters, and preserve clinician responsibility for every clinical decision.',
    ].join(' '),
  });
  for (const { name, config, handler } of selectedTools) {
    server.registerTool(name, config, handler);
  }
  for (const { name, config, handler } of prompts) {
    server.registerPrompt(name, config, handler);
  }
  for (const { name, uri, config, read } of resources) {
    server.registerResource(name, uri, config, read);
  }
  // This catalog is immutable for the lifetime of a server instance. The SDK
  // defaults all three list-change flags to true when definitions are
  // registered; override them so clients can cache the catalog honestly.
  server.server.registerCapabilities({
    tools: { listChanged: false },
    prompts: { listChanged: false },
    resources: { listChanged: false },
  });
  return server;
}
