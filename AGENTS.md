# Repository Agent Guide

`AGENTS.md` is the canonical agent guide.

## Project Overview

OathMCP is a TypeScript Model Context Protocol (MCP) server implementing 39
established clinical calculators (BMI, GFR, MELD, etc.) as agent-native tools,
with per-value US/SI unit handling, plausibility guards, evidence resources, and
interpreter prompts. It runs over stdio (`npx oath-mcp`), stateless HTTP, or
Cloudflare Workers. The project implements documented instruments; it is not new
clinical research. Read `docs/RESPONSIBLE_USE.md` before changing public-facing
clinical, deployment, warranty, or responsibility language.

## Commands

```bash
# Full acceptance check
npm run check

# Individual checks
npm run lint:specs
npm run typecheck
npm run build
npm run test
npm run check:clinical-release
npm run check:package

# Run the MCP server
npm run start:stdio        # stdio transport (node dist/server/stdio.js)
npm run start:http         # stateless HTTP transport
npx @modelcontextprotocol/inspector node dist/server/stdio.js   # inspect tools/prompts/resources

# Exercise one calculator through the engine
npx tsx -e "import('./src/engine/run.ts').then(m=>console.log(m.run('bmi',{weight_kg:70,height_cm:170})))"
```

## Architecture

The server is **spec-driven**: each live calculator has a strict YAML spec, an
exactly typed pure TypeScript compute function, and an implementation-assurance
dossier. There is no manual per-calculator server wiring — the MCP surface is
derived from the live specs at startup.

Layers (all MCP-SDK imports are confined to `src/server/**` to keep the protocol boundary isolated):

- **`specs/<id>.yaml`** — the runtime contract: metadata, evidence, inputs, outputs, bands, and warning/cap rules. Runtime specs contain no test fixtures. Validated by `SpecSchema` (`src/engine/spec-schema.ts`) at load time.
- **`src/engine/`** — spec loading (`load-specs.ts`), the unit-conversion table (`units.ts`, the single conversion source of truth), the band-expression evaluator (`bands.ts`, a closed hand-written grammar — no `eval`), the compute registry (`registry.ts`), typed errors (`errors.ts`), and the runner `run(id, rawInputs)` (`run.ts`) that normalizes units, enforces plausibility/hard-limit/cap rules, calls the compute fn, evaluates bands, and returns a normalized `CalcResult` envelope.
- **`src/compute/<id>.ts`** — a pure function over canonical-unit inputs, registered via `registerCompute('<id>', fn)`. Receives inputs already normalized to canonical (US) units. `round.ts` provides deterministic half-even decimal rounding. `src/compute/index.generated.ts` is generated from the spec filenames and owns side-effect registration imports.
- **`src/server/build-tools.ts`** — `buildServer()` derives, per spec, a `calculate_<id>` tool (input/output schemas from the spec), an `evidence_<id>` resource, and (if the spec has a `prompt` block) an `interpret_<id>` prompt. Also registers the agent-dispatch tools `find_calculator`, `describe_calculator`, and `calculate_panel`. Entrypoints: `stdio.ts`, `http.ts`, `worker.ts`.

### Calculator types (all expressed in the same spec + compute bundle)
- **Formula-based**: direct math (BMI, MAP, BSA).
- **Unit-conversion formula**: lab values with per-value US/SI units as `quantity` inputs (GFR, MELD, KDPI).
- **Enum-score**: enum options carrying explicit `points`, summed in compute (NIHSS, GCS, CHA₂DS₂-VASc).
- **Boolean-criteria**: yes/no items summed in compute (qSOFA, Wells DVT).
- **Interpreter**: deterministic computed outputs plus a `prompt` block for LLM interpretation (ABG, CSF, HepB).

### Testing
- **`validation/calculators/<id>.yaml`** — reproducible searches, claim locators,
  and source-derived reference, edge, and agent cases kept outside runtime data.
- **`test/golden.test.ts`** — runs authoritative dossier reference cases and
  exact output-presence checks for every live calculator.
- **`test/property/`** — fast-check invariants (monotonicity, positivity, US/SI equivalence).
- **`src/**/*.test.ts`** — colocated engine/server unit and in-memory MCP integration tests.

### Validation constraints
- A green test suite confirms the checked-in implementation contract. The
  source/scenario gate additionally proves exact source linkage and three-surface
  behavior, but neither gate decides whether a calculator is appropriate for an
  individual patient. Before changing formulas, cutoffs, interpretations, or
  citations, verify the change against the primary or responsible authoritative
  source.
- `npm run lint:specs` enforces spec/compute pairing, fixture-free runtime specs, numeric band coverage, prompt placeholders, units, defaults, ranges, evidence URLs, and filename/ID identity. Add new authoring rules to the linter rather than relying on prose alone.

### Product and responsibility language

- Describe the included calculators as established, published, or documented;
  never imply OathMCP invented or clinically revalidated them.
- Use `source_verified` and `scenario_verified` only with their repository-defined
  meanings. Do not shorten either to an unqualified “clinically validated.”
- Preserve clinician discretion: OathMCP provides decision-support calculations,
  while a clinician remains responsible for calculator selection, inputs, units,
  applicability, interpretation, and every clinical decision.
- Preserve the deployer boundary for authentication, privacy, protected health
  information, regulatory compliance, monitoring, and source/version updates.
- Keep the short README/MCP language linked to the canonical notice in
  `docs/RESPONSIBLE_USE.md`; do not create divergent disclaimers.
- Preserve the Apache-2.0 identity in `LICENSE`, `NOTICE`, package metadata, and
  distribution documentation. The license and Responsible Use notice serve
  different purposes; do not present either as a substitute for the other.

## Creating New Calculators

New work uses a staged promotion workflow. See [`docs/AUTHORING.md`](docs/AUTHORING.md).

1. Run `npm run new:calculator -- --id <id> --archetype formula|score|lookup|interpreter`.
2. Complete the draft spec, standalone typed compute, reproducible search, claims, and source-derived cases under `drafts/calculators/<id>/`.
3. Run `npm run check:calculator -- --id <id>`.
4. Run `npm run promote:calculator -- --id <id>`; promotion writes live files and generated artifacts only after isolated compile, engine, MCP, source, and scenario gates pass.
5. Run `npm run check` and inspect the MCP surface. User-created drafts are excluded from runtime loading, normal generation, CI, and packaging.

`src/server/build-tools.ts` derives the `calculate_<id>` tool, the
`evidence_<id>` resource, and (if the spec has a `prompt` block) the
`interpret_<id>` prompt from the spec at startup.

## Key Files
- `src/engine/run.ts` - the runner: unit normalization, plausibility/cap guards, band evaluation, `CalcResult` envelope
- `src/engine/units.ts` - the unit-conversion table (single conversion source of truth)
- `src/engine/spec-schema.ts` - the Zod `SpecSchema` every `specs/*.yaml` is validated against
- `src/server/build-tools.ts` - `buildServer()`; derives all MCP tools, prompts, and resources from the specs
- `specs/` - the calculator specs (source of truth); `src/compute/` - the pure compute functions
- `docs/RESPONSIBLE_USE.md` - canonical clinical, deployment, privacy, warranty, and responsibility boundary
- `docs/RELEASE.md` - repository, package, and hosted-endpoint release checklist
- `LICENSE` and `NOTICE` - Apache-2.0 grant and project attribution
- `validation/releases/<version>.yaml` - source-version and release-currentness attestation
