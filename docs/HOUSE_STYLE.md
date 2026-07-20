# Calculator Spec House Style

OathMCP exposes one coherent MCP vocabulary across every calculator. The spec
linter enforces the rules that affect tool composition; this guide covers the
authoring choices that keep schemas predictable for agents and clients.

## Identifiers

- Use lowercase `snake_case` for calculator, input, output, and enum identifiers.
- Use `sex` with `male` and `female` when a formula requires biological sex.
- Use explicit measurement names: `weight_kg`, `weight_grams`, `height_cm`,
  `systolic_bp`, and `diastolic_bp`.
- Use lowercase analyte and blood-gas names: `sodium`, `chloride`, `bicarbonate`,
  `ph`, `paco2`, `pao2`, and `fio2`.
- Use a positive-condition noun for booleans, such as `venous_sample`.
- Use `score` as the primary output for new point-based scores. Use descriptive
  output ids when a calculator returns multiple distinct clinical quantities.

Compatibility spellings belong in `aliases`; only the canonical identifier is
advertised in generated MCP schemas. Alias use produces a warning in the result
envelope.

## Units and labels

- Use ASCII unit tokens in schemas, including `umol/L`, `cmH2O`, and `uL`.
- Put units in quantity metadata and output `unit` fields. Keep titles short and
  put measurement detail in descriptions.
- A bare quantity value always means the declared canonical unit. List every
  accepted unit explicitly and add an equivalence vector when conversion matters.
- Every input declares a clinical `conceptId`. Panel sharing is opt-in through
  `sharedKey`; the same shared key may be reused only when concept ID, kind,
  enum domain, and canonical unit are identical. Role-specific values (for
  example donor weight versus patient weight) must not share a key.

## Clinical metadata

- Name the exact formula, publication, population, and time horizon. Avoid broad
  labels when several variants exist.
- Use `family` and `variant` for related formulas, and add `synonyms` and
  `abbreviations` for retrieval.
- Cite primary literature or an authoritative policy source for every formula,
  cutoff, interpretation band, correction, and lookup table.
- Add `reviewAfter` when an authority updates a reference on a known schedule.
- Give every evidence item a stable `id`, source type, and exact locator. Link
  inputs, outputs, bands, warnings, applicability, model identity, scoring, and
  adjustments back through `sourceRefs` or `evidenceRefs`.

## Strict input and output contracts

- Specs and every nested authoring object reject unknown keys. Do not add an
  arbitrary metadata bag; extend the reviewed schema and linter deliberately.
- Input kinds are mutually exclusive. Each option includes a stable token,
  human label, and agent-facing description; defaults live only on the branch
  whose primitive type they match.
- Every output declares an exact kind (`number`, `integer`, `boolean`, `string`,
  `enum`, `string_list`, `number_list`, or `number_range`) and availability.
  Closed categorical outputs use `enum` with exhaustive `allowedValues`; free
  text uses `string`. Range values are `{ low, high, mean? }`; lists contain one
  primitive type.
- Use `always`, `whenAnyInputPresent`, or `whenAllInputsPresent` for presence
  rules based on normalized inputs. Value-dependent rules use a named
  TypeScript predicate registered with `registerOutputCondition`; never put an
  expression language in YAML.
- List primary outputs in preference order with `primaryOutputs`. Each band has
  a stable `code`, semantic `kind`, and evidence references. Urgency and
  recommendations remain separately sourced claims.

## Behavior and regression vectors

- Compute functions receive generated, canonical-unit input types and return
  only declared values matching the generated output type. The runtime rejects
  missing, unexpectedly present, malformed, non-finite, and undeclared outputs.
- Result schema 1.1 preserves `results[]`, JSON text, `structuredContent`, and
  the legacy first `interpretation`, while adding authoritative
  `interpretations[]`, input provenance, scoring components, and adjustments.
- Declare each cap, floor, or clamp against an explicit numeric input/output
  target, with a bounded equality condition when needed. Link warnings to the
  adjustment ID and use `verifyOutput` when the compute exposes the effective
  input value. If that output is rounded, declare the narrow verification
  tolerance explicitly.
- Put reusable validation in spec constraints and cap/clamp warnings in the spec.
- Use output-specific interpretation bands when a calculator has more than one
  interpretable result.
- Keep runtime specs fixture-free. Put at least three source-linked reference
  cases plus feature-derived edge and agent cases in the validation dossier.
- Author only under `drafts/calculators/<id>/`. Promotion requires strict spec,
  exact compute types, source and scenario verification, isolated generation,
  engine/MCP execution, and a green acceptance suite before live files change.
- Run `npm run gen:specs` after changing specs, then run `npm run check`.

## Public responsibility language

- Describe OathMCP as an implementation of established, documented calculators,
  not new research or a revalidation of the underlying instruments.
- Use exact derived review states instead of an unqualified “clinically
  validated.”
- Make clinician discretion explicit in public descriptions, prompts, and
  examples. Calculated results support rather than replace professional
  judgment.
- Link to `docs/RESPONSIBLE_USE.md` for the complete responsibility boundary
  instead of duplicating or weakening it in individual calculator prose.
