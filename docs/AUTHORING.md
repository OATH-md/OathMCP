# Authoring and Promoting a Calculator

Live OathMCP calculators are promoted artifacts, not scratch space. Authoring
starts in `drafts/calculators/<id>/`; normal loading, generation, CI, and npm
packaging ignore that directory. Promotion writes the live spec, compute,
validation dossier, catalog enrollment, and generated artifacts only after an
isolated preflight passes.

## 1. Scaffold a draft

```bash
npm run new:calculator -- --id corrected_measure --archetype formula
```

Choose exactly one archetype: `formula`, `score`, `lookup`, or `interpreter`.
The command refuses to overwrite an existing draft and creates:

- `spec.yaml` — draft runtime contract;
- `compute.ts` — standalone typed pure compute function;
- `validation.yaml` — independent search, claims, sources, and cases.

Templates contain explicit TODOs and no invented citations. Remove a TODO only
after replacing it with reviewed content. User-created `drafts/` never ship;
the four reusable bundles under `templates/calculator/` do.

## 2. Complete the strict runtime contract

The production schema is `SpecSchema` in `src/engine/spec-schema.ts`. It rejects
unknown keys. Every live spec must define:

- exact clinical model, variant/data snapshot, effective/review dates when
  applicable, population, setting, timing, endpoint, and exclusions;
- stable evidence IDs and exact locators linked from model, inputs, outputs,
  bands, warnings, adjustments, applicability, and scoring metadata;
- mutually exclusive typed inputs with `conceptId`, examples, source refs,
  canonical units and accepted per-value units where applicable;
- exact output kinds and availability (`always`, input-presence rules, or a
  reviewed named TypeScript condition), plus ordered `primaryOutputs`;
- observation metadata for raw time-dependent measurements: `phase`, a numeric
  `timestampField`, `derivation`, and (only for change-from-baseline rules) a
  type- and unit-compatible `baselineField`. Keep the timestamp and measurement
  as separate strict inputs so each value retains normal input provenance;
- `criterion_list` outputs when a finite score must expose structured derived
  criterion provenance (`criterion`, `state`, optional `points`,
  `observedInputs`, and `rationale`) instead of accepting caller-classified
  booleans. Use `forbidPresentWhen` to reject observations supplied before they
  are due or for a variant where they are not applicable;
- typed score components, adjustments, constraints, variants, lifecycle links,
  and prompt branches only when the calculator needs them.

Runtime specs contain no test fixtures. Historical regression fixtures and
independent cases belong in the dossier and never enter Worker/runtime
descriptors.

## 3. Implement the standalone compute

The draft must export `compute` and local exact input/output interfaces:

```ts
export interface Inputs { readonly value: number }
export interface Outputs { readonly result: number }

export function compute(inputs: Inputs): Outputs {
  return { result: inputs.value };
}
```

The function receives normalized canonical-unit inputs and performs no I/O,
unit conversion, or request validation. The promotion preflight places it
behind `registerCompute`, regenerates exact catalog types, and lets TypeScript
reject missing, misspelled, or wrongly typed inputs and outputs. Use
`roundHalfEven` in live code when the clinical contract declares decimal
rounding.

For temporal scores, the compute function—not the caller—derives `met`,
`not_met`, `unknown`, `not_due`, and `not_applicable` from raw normalized
observations and their timestamps. A completed total must be absent until every
applicable observation is available; do not coerce missing or not-yet-due data
to zero.

## 4. Build the implementation-assurance dossier

Follow `validation/SEARCH_PROTOCOL.md`. Record the exact MEDLINE and authority
queries, interface and filters, date coverage, result IDs or export digest,
deduplication method/tool/version, PRISMA-S counts, exclusion reasons, citation
chasing, correction/retraction/supersession checks, and resolved independent
PRESS-derived review of the initial MEDLINE strategy.

Use only the source bundle required by the archetype:

- formula: bibliographic search, derivation, current authority/specialty
  guidance, and independent numeric reconstruction;
- score: derivation plus external validation and current authority guidance;
- lookup/policy: derivation, external validation, current controlling authority,
  and immutable versioned data release;
- interpreter: bibliographic search, derivation, current authority/specialty
  guidance, and exhaustive deterministic branch support.

Commercial calculators, blogs, and textbooks are discovery-only. US approved
label claims require Drugs@FDA or regulator-approved prescribing information.
Map every formula, coefficient, input, unit, default, cap, cutoff, band,
outcome, applicability rule, exclusion, warning, interpretation, and
recommendation to exact source locators. Resolve conflicts and variants rather
than hiding them in prose.

Add at least three source-linked `reference` cases plus every feature-derived
edge tag and relevant `agent` scenario. Cases contain immutable inputs,
expected outputs/omissions/warnings/errors/interpretations, tolerances, claim
links, source links, and semantic witnesses. They never author pass/fail state.
Review state is derived by executing engine and MCP paths; promotion requires
both `source_verified` and `scenario_verified`. These states confirm source
traceability and implementation behavior for an established calculator. They do
not claim that OathMCP created or clinically revalidated the underlying
instrument, and they do not remove the clinician's responsibility to decide
whether the calculator applies.

## 5. Check and promote

```bash
npm run check:calculator -- --id corrected_measure
npm run promote:calculator -- --id corrected_measure
npm run check
npx @modelcontextprotocol/inspector node dist/server/stdio.js
```

`check:calculator` reports incomplete evidence, fields, claims, cases, tags, or
placeholders. A complete candidate is copied to an isolated workspace, added to
a prospective catalog, regenerated, typechecked, executed through engine and
MCP cases, and tested without registering it globally.

`promote:calculator` repeats that preflight and refuses overwrite. Any preflight
failure writes no live candidate files. A successful run installs the strict
spec, typed compute, dossier, catalog membership, and generated artifacts.

## 6. Generate the Blume documentation

Every calculator pull request must include its generated Blume reference page.
Assign the calculator to exactly one category in
`docs-site/scripts/generate-calculators.mjs`, then run:

```bash
npm --prefix docs-site run generate
npm --prefix docs-site run check
```

Commit the category assignment and generated `docs-site/docs/calculators/**`
changes with the calculator. The docs check derives the live calculator count,
requires exactly one generated page for every spec, and fails on an unassigned,
missing, duplicate, or stale page. Do not hand-author the generated calculator
page.

Contributor CI runs both `npm run check` and the Blume check. A merged
calculator is therefore locally complete and documented, but it is still
unreleased until a maintainer prepares and tags a version through
[`RELEASE.md`](RELEASE.md).

## Release and later corrections

`npm run check` is the non-network acceptance gate. Publication additionally
runs `npm run check:release`, which requires current complete searches,
claim-level source verification, passing source-derived scenarios, a
package-version attestation, generated Blume parity, a package dry run, and the
ordinary acceptance suite. This is an implementation and release-integrity
gate, not a separate credential or transfer of clinical responsibility. Public
releases and deployments must carry `docs/RESPONSIBLE_USE.md`.

When a user reports a clinical issue, trace it to the exact claim and source,
refresh the governing evidence when needed, correct the spec/compute/dossier,
and add the report as a source-linked regression scenario. Re-run the candidate
or full catalog gates.
