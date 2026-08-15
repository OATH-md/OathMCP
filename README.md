# OathMCP

An agent-native [Model Context Protocol](https://modelcontextprotocol.io) server
for 40 established clinical calculators and structured interpretation tools.
OathMCP gives AI agents strict input and output schemas, per-value unit handling,
plausibility guards, cited evidence resources, and deterministic calculation
paths over stdio, stateless HTTP, and Cloudflare Workers.

The included calculators are documented clinical instruments, formulas, and
policy models. OathMCP is an implementation of those sources, not new clinical
research and not a replacement for the original publications, governing
policies, or local protocols.

> **Responsible use:** OathMCP provides clinical decision-support calculations,
> not medical advice, diagnosis, or treatment. The clinician remains responsible
> for selecting the appropriate calculator, confirming its population and
> version, checking the inputs and units, interpreting the result in context,
> and making every clinical decision. See
> [Responsible Use](docs/RESPONSIBLE_USE.md) for the complete responsibility,
> deployment, privacy, warranty, and limitation-of-liability notice.

## Release status

The hosted MCP and Blume documentation are published together from one verified
`v*` tag. Check the [live service metadata](https://mcp.oath.md/health) for the
deployed version and [GitHub Releases](https://github.com/OATH-md/OathMCP/releases)
for its exact source and release notes. The `0.2.1` attestation covers all 40
calculators, including FIB-4, and the release supports modern MCP protocol
`2026-07-28` while retaining the documented stateless legacy era.

The first public npm package is
[`@oath-md/oath-mcp@0.2.1`](https://www.npmjs.com/package/@oath-md/oath-mcp/v/0.2.1).
The hosted MCP, Blume documentation, npm package, and GitHub release are
verified from the same tagged commit.

All 40 calculator dossiers and all four review groups currently derive
`scenario_verified`, and the ordinary acceptance, transport, compatibility,
and package gates pass.

In OathMCP, `scenario_verified` has a precise repository meaning: the implemented
model and its declared population, variant, inputs, outputs, warnings,
interpretations, and exclusions are linked to reviewed sources and pass frozen
source-derived cases through the engine, full MCP tool, and compact MCP tool.
It does not mean regulatory approval, guarantee suitability for an individual
patient, or remove clinician discretion.

- [0.2.1 release attestation](validation/releases/0.2.1.yaml)
- [npm package](https://www.npmjs.com/package/@oath-md/oath-mcp)
- [GitHub releases](https://github.com/OATH-md/OathMCP/releases)
- [Live service metadata](https://mcp.oath.md/health)
- [Release process](docs/RELEASE.md)
- [Changelog](CHANGELOG.md)

## Quick start

### From source

Requires Node.js 22 or later.

```bash
git clone https://github.com/OATH-md/OathMCP.git
cd OathMCP
npm ci
npm run check
npm run start:stdio
```

Configure an MCP-compatible client to run the built stdio server:

```json
{
  "mcpServers": {
    "oath": {
      "command": "node",
      "args": ["/absolute/path/to/OathMCP/dist/server/stdio.js"]
    }
  }
}
```

### npm package

Run the exact reviewed release as a local stdio MCP server:

```json
{
  "mcpServers": {
    "oath": {
      "command": "npx",
      "args": ["-y", "@oath-md/oath-mcp@0.2.1"]
    }
  }
}
```

For programmatic use, install the same exact version and import the public
engine or MCP server entrypoint:

```bash
npm install --save-exact @oath-md/oath-mcp@0.2.1
```

```ts
import { run } from '@oath-md/oath-mcp';
import { buildServer } from '@oath-md/oath-mcp/server';
```

The installed executable remains `oath-mcp`; only the npm package and import
scope are namespaced.

## Remote deployment

The remote server is stateless: each request receives a fresh MCP server and no
session state is retained. A client points at the deployed streamable HTTP URL:

```json
{
  "mcpServers": {
    "oath": {
      "url": "https://mcp.oath.md/mcp"
    }
  }
}
```

The stdio, Node HTTP, and Worker entrypoints use one MCP SDK v2 implementation
to serve modern protocol `2026-07-28` and the supported stateless legacy era.
Modern HTTP requests include protocol/client metadata in the message and mirror
routing through `MCP-Protocol-Version`, `Mcp-Method`, and, when applicable,
`Mcp-Name`. Browser preflights allow `Accept`, `Content-Type`, and those three
MCP headers. HTTP responses use `Cache-Control: no-store`; the SDK selects JSON
for complete non-streaming exchanges and request-scoped SSE when required,
without creating a persistent MCP session.

Around February 2027 is only the earliest review date for legacy support, not a
protocol cutoff. Removing it requires a later announced breaking release after
at least two successful modern OathMCP releases, support in the major documented
clients, consistently green modern-first production verification, and advance
deprecation notice.

Run the HTTP transports locally:

```bash
npm run start:http          # Node/Express on http://127.0.0.1:3000/mcp
npx wrangler dev            # Cloudflare Workers development server on /mcp
```

The Node server binds to `127.0.0.1` by default. Set `HOST` and `PORT` only when
the deployment boundary is intentional. Browser clients must have their exact
origin in the comma-separated allowlist:

```bash
OATH_ALLOWED_ORIGINS=https://app.example,https://review.example npm run start:http
```

An absent `Origin` is accepted for non-browser MCP clients. Any nonempty origin
not present in `OATH_ALLOWED_ORIGINS` receives HTTP 403; wildcard origin rules
are not supported. Use the same binding for Worker deployments. Both HTTP
implementations accept CORS preflight with `OPTIONS /mcp`, perform MCP requests
with `POST /mcp`, and return a JSON 405 without reading the body for every other
method on that path.

Deploy to Workers only after reviewing [Responsible Use](docs/RESPONSIBLE_USE.md),
the security and privacy boundary, and the release checklist. The official
MCP and Blume Workers deploy from one exact `v*` tag only after
`npm run check:release` passes; the workflow then verifies the live catalog,
modern and legacy clients, new-calculator execution, and every generated
calculator page before creating the GitHub release. For a manual recovery
deployment from an exact release tag:

```bash
npm run check:release
npm run deploy:production -- \
  --tag "$(git describe --tags --exact-match)" \
  --sha "$(git rev-parse HEAD)"
```

The official documentation is available at `https://mcp.oath.md/docs/`, and the
public unauthenticated endpoint is `https://mcp.oath.md/mcp`. The endpoint serves
the compact four-tool dispatch surface,
applies an edge limit of 120 requests per client per minute, accepts browser
requests only from `https://oath.md` and `https://mcp.oath.md`, and enables
10% sampled Workers observability. Application code does not log request bodies.
Service metadata is available at `https://mcp.oath.md/health`; the complete
notice is available at `https://mcp.oath.md/responsible-use` and through the MCP
resource `oath://responsible-use`. The independently deployed Blume source lives
in the [documentation site directory](https://github.com/OATH-md/OathMCP/tree/main/docs-site).
See [Hosted endpoint operations](docs/HOSTING.md).

OathMCP does not require patient identifiers. A deployment that accepts
protected or personal health information is the deployer's responsibility and
must provide the authentication, authorization, logging, retention, contractual,
and regulatory controls required in its jurisdiction.

## MCP surface

For each calculator, full mode registers:

- `calculate_<id>` — a read-only calculation tool returning result schema 1.1;
- `evidence_<id>` — a resource at `calc://<id>/evidence` containing citations,
  interpretation bands, limitations, and safety notes;
- `interpret_<id>` — for ABG, CSF, and hepatitis B, a prompt that asks the host
  model to summarize deterministic findings without adding a diagnosis or
  treatment plan.

Four agent-dispatch tools sit above the catalog:

- `find_calculator` returns a bounded ranked set plus `matched`,
  `needs_clarification`, or `no_match`; a clarification state must be resolved
  before calculation;
- `describe_calculator` returns the exact model, inputs, outputs, limitations,
  version, and evidence metadata;
- `calculate_panel` runs selected calculators against compatible shared inputs,
  with isolated per-calculator failures; duplicate ids and unused shared or
  override keys are rejected instead of silently ignored;
- `calculate` dispatches one calculator in compact mode with the same clinical
  contract as its direct tool.

Set `OATH_MCP_MODE=compact` to expose only the four dispatch tools while keeping
all evidence resources. Full mode is the compatibility default.

Analyte inputs accept either a bare number in the documented canonical unit or
an explicit quantity:

```json
{
  "creatinine": {
    "value": 106,
    "unit": "umol/L"
  }
}
```

Bare values always use the field's declared canonical unit. There is no global
US/SI mode.

## Calculator catalog

| id | calculator | interpretation prompt |
|---|---|:---:|
| `aa_gradient` | Alveolar-arterial oxygen gradient | |
| `abg` | ABG/VBG acid-base findings | ✓ |
| `anion_gap` | Anion gap with albumin correction | |
| `apgar` | APGAR score | |
| `bmi` | Body mass index | |
| `bsa` | Body surface area, Mosteller | |
| `bsa_dubois` | Body surface area, DuBois | |
| `carboplatin_auc` | Carboplatin dose, Calvert | |
| `chadsvasc` | CHA₂DS₂-VASc score | |
| `chemo_dose_bsa` | BSA-based chemotherapy dose | |
| `child_pugh` | Child-Pugh score | |
| `corrected_calcium` | Corrected calcium, Payne | |
| `creatinine_clearance` | Creatinine clearance, Cockcroft-Gault | |
| `csf` | CSF findings | ✓ |
| `eos` | Neonatal early-onset sepsis | |
| `free_water_deficit` | Free-water deficit in hypernatremia | |
| `gad7` | GAD-7 | |
| `gcs` | Glasgow Coma Scale | |
| `gfr` | Estimated glomerular filtration rate | |
| `gir` | Glucose infusion rate | |
| `grace` | GRACE admission-to-six-month mortality | |
| `hepb` | Hepatitis B triple-panel findings | ✓ |
| `ibw` | Ideal body weight, Devine | |
| `ich_volume` | Intracerebral hemorrhage volume, ABC/2 | |
| `kdpi` | Kidney Donor Profile Index | |
| `map` | Mean arterial pressure | |
| `meld` | MELD 3.0 | |
| `mews` | Modified Early Warning Score | |
| `morse_fall_scale` | Morse Fall Scale | |
| `neonatal_measurements` | Neonatal measurement estimates | |
| `nihss` | NIH Stroke Scale | |
| `oxygenation_index` | Oxygenation index and oxygen saturation index | |
| `pews` | Brighton/Monaghan Pediatric Early Warning Score | |
| `qsofa` | Quick Sequential Organ Failure Assessment | |
| `r_factor` | R factor for liver injury | |
| `ranson` | Ranson criteria | |
| `sodium_deficit` | Sodium deficit in hyponatremia | |
| `timi` | TIMI risk score for UA/NSTEMI | |
| `wells_dvt` | Modified two-level Wells DVT score | |

## Architecture and assurance

Each live calculator consists of three reviewed artifacts:

1. `specs/<id>.yaml` defines the strict runtime and MCP contract;
2. `src/compute/<id>.ts` provides a pure, exactly typed calculation over
   normalized inputs;
3. `validation/calculators/<id>.yaml` records searches, exact claim locators,
   current sources, and frozen reference, edge, and agent cases.

The server derives its tools, prompts, and resources from the specs. Runtime
specs contain no test fixtures. Review state is derived by code rather than
authored in YAML, and release checks fail when required sources, cases,
attestations, or currentness windows are incomplete.

The assurance ledger verifies that OathMCP implements the declared calculator
version and documented behavior. It does not claim that OathMCP invented or
revalidated the underlying clinical instrument.

## Development and contribution

```bash
npm run check                   # complete acceptance gate
npm run check:clinical-release  # source, scenario, currentness, and attestation gate
npm run check:release           # exact version, Blume, package, and release gate
npm run new:calculator -- --id example --archetype formula
npm run check:calculator -- --id example
npm run promote:calculator -- --id example
npm --prefix docs-site run generate
npm run lint:specs
npm run typecheck
npm run test
npm run build
```

See [Contributing](CONTRIBUTING.md), the
[calculator authoring guide](docs/AUTHORING.md), and the
[spec house style](docs/HOUSE_STYLE.md). Report security or patient-safety
issues through [Security Policy](SECURITY.md) and never include patient data in
an issue, test, or example.

## Documentation

- [Responsible use and responsibility allocation](docs/RESPONSIBLE_USE.md)
- [Calculator authoring and promotion](docs/AUTHORING.md)
- [Specification house style](docs/HOUSE_STYLE.md)
- [Clinical assurance ledger](validation/README.md)
- [Reproducible source-review protocol](validation/SEARCH_PROTOCOL.md)
- [Release process](docs/RELEASE.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

OathMCP is available under the [Apache License 2.0](LICENSE). Copyright and
attribution information is provided in [NOTICE](NOTICE). The license governs
permission to use, modify, and distribute the software; it does not replace the
clinical and operational boundaries in [Responsible Use](docs/RESPONSIBLE_USE.md).
