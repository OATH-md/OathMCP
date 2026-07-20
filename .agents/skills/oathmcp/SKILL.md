---
name: oathmcp
description: Find, inspect, and run OathMCP's established clinical calculators with explicit units, clarification of ambiguous model, population, variant, or input choices, and source-linked results. Use when a user explicitly invokes OathMCP or asks to calculate, score, estimate, stage, screen, compare, or identify a supported clinical calculator. Do not use for diagnosis, treatment selection, unrelated medical advice, or patient-record storage.
---

# OathMCP

Use OathMCP as a conversational clinical-calculation workflow. It exposes four
read-only tools:

- `find_calculator` finds candidate calculators from clinical intent.
- `describe_calculator` returns one calculator's inputs, units, applicability,
  limitations, outputs, model metadata, and evidence resource.
- `calculate` runs one already-selected calculator.
- `calculate_panel` runs multiple already-selected calculators with reviewed
  shared inputs and calculator-specific overrides.

## Workflow

1. Identify the exact calculation, population, model, and variant.
   - Call `find_calculator` when the canonical calculator ID is unknown.
   - If discovery returns `needs_clarification`, present the relevant choices
     briefly and ask the user which one applies.
   - Never silently choose between clinical models, formulas, variants, or
     populations.
2. Call `describe_calculator` before calculating unless the exact current input
   contract is already established in the conversation.
3. Continue the conversation until the required inputs and units are clear.
   - Ask one concise, high-value clarification at a time, grouping only closely
     related missing inputs.
   - Preserve information the user already supplied; do not restart the intake.
   - Explain accepted units or enum choices when that helps the user answer.
   - Never invent, assume, impute, or silently default a missing patient value.
4. Use `calculate` for one calculator. Use `calculate_panel` only when the user
   has selected multiple calculators and their shared inputs are compatible.
5. Treat tool errors as actionable clarification. Explain the invalid or missing
   field in plain language and ask for a corrected value rather than fabricating
   a result.

## Response contract

After every successful calculation:

1. State the calculator and clinical model or variant used.
2. Report the result with units, interpretation, input provenance, adjustments,
   score completeness, and warnings when present.
3. Summarize applicability and limitations that materially affect use. Preserve
   clinician discretion; do not turn a calculation into diagnosis or treatment
   advice.
4. Add a **Sources** section even when the user did not request citations.
   - Cite every source returned in the result's `evidence` array.
   - Link the returned URL and include the citation, locator, and DOI when
     available.
   - For a panel, keep sources associated with their calculator; deduplicate only
     identical references without losing that association.
   - Never invent, replace, or strengthen a source or claim beyond the returned
     evidence.
   - If inline evidence is unexpectedly absent, read the returned `evidenceUri`
     resource (`calc://<id>/evidence`) and cite it before presenting the response.
     If source retrieval still fails, disclose that failure instead of implying
     the result is sourced.

Use this compact response shape unless the user requests another format:

```markdown
**Result**
<calculator, value, units, interpretation>

**Important context**
<warnings, applicability, limitations, or missing-score reasons>

**Sources**
- [<citation>](<returned URL>) — <locator>; DOI: <DOI when present>
```

## Safety and privacy

- Request only the minimum de-identified inputs required by the selected
  calculator. Do not request or transmit names, medical-record numbers,
  free-text notes, or other patient identifiers.
- Describe the calculators as established, published, or documented. Do not say
  OathMCP invented or independently clinically validated them.
- Keep calculator selection, input accuracy, applicability, interpretation, and
  clinical decisions with the qualified clinician.
- If the user asks for diagnosis, autonomous treatment, or emergency triage,
  explain that OathMCP performs calculations only and direct them to appropriate
  clinical evaluation.
