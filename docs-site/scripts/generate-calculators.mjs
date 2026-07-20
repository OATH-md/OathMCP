import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(projectRoot, "..");
const outputRoot = join(projectRoot, "docs", "calculators");
const checkOnly = process.argv.includes("--check");

const categories = [
  {
    slug: "general-measurements",
    title: "General measurements",
    icon: "ruler",
    description: "Anthropometric, body-surface, ideal-weight, and hemodynamic measurements.",
    ids: ["bmi", "bsa", "bsa_dubois", "ibw", "map"],
  },
  {
    slug: "renal-electrolytes",
    title: "Renal and electrolytes",
    icon: "droplets",
    description: "Kidney function, electrolyte corrections, and water or sodium balance.",
    ids: ["anion_gap", "corrected_calcium", "creatinine_clearance", "free_water_deficit", "gfr", "sodium_deficit"],
  },
  {
    slug: "respiratory-critical-care",
    title: "Respiratory and critical care",
    icon: "activity",
    description: "Gas exchange, acid-base interpretation, oxygenation, and deterioration screening.",
    ids: ["aa_gradient", "abg", "mews", "oxygenation_index", "qsofa"],
  },
  {
    slug: "neurology-safety",
    title: "Neurology and safety",
    icon: "brain",
    description: "Neurologic examination, hemorrhage volume, stroke severity, and fall risk.",
    ids: ["gcs", "ich_volume", "morse_fall_scale", "nihss"],
  },
  {
    slug: "cardiovascular-thrombosis",
    title: "Cardiovascular and thrombosis",
    icon: "heart-pulse",
    description: "Acute coronary, atrial-fibrillation, and venous-thrombosis risk instruments.",
    ids: ["chadsvasc", "grace", "timi", "wells_dvt"],
  },
  {
    slug: "hepatology-gastroenterology",
    title: "Hepatology and gastroenterology",
    icon: "hospital",
    description: "Liver severity, injury patterns, hepatitis serology, and pancreatitis scoring.",
    ids: ["child_pugh", "hepb", "meld", "r_factor", "ranson"],
  },
  {
    slug: "pediatrics-neonatology",
    title: "Pediatrics and neonatology",
    icon: "baby",
    description: "Newborn assessment, neonatal measurements, early-onset sepsis, glucose delivery, and pediatric warning scores.",
    ids: ["apgar", "eos", "gir", "neonatal_measurements", "pews"],
  },
  {
    slug: "oncology-transplant",
    title: "Oncology and transplant",
    icon: "syringe",
    description: "Chemotherapy dosing support and kidney donor profile calculations.",
    ids: ["carboplatin_auc", "chemo_dose_bsa", "kdpi"],
  },
  {
    slug: "clinical-assessment",
    title: "Clinical assessment",
    icon: "clipboard-check",
    description: "Structured symptom and fluid interpretation outside the other specialty groups.",
    ids: ["csf", "gad7"],
  },
];

function md(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("\n", " ")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .trim();
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function range(value) {
  return Array.isArray(value) ? `${value[0]}–${value[1]}` : "—";
}

function inputType(input) {
  if (input.kind === "quantity") {
    return `quantity (${input.quantity.acceptedUnits.join(" | ")})`;
  }
  if (input.kind === "enum") return `enum (${input.enumValues.length} options)`;
  return input.kind;
}

function defaultValue(input) {
  if (!("default" in input)) return "—";
  return `\`${JSON.stringify(input.default)}\``;
}

function outputType(output) {
  const unit = output.unit ? ` · ${output.unit}` : "";
  return `${output.kind}${unit}`;
}

function availability(value) {
  if (!value || value.kind === "always") return "Always";
  if (value.kind === "whenAnyInputPresent") return `When any of: ${value.fields.join(", ")}`;
  if (value.kind === "whenAllInputsPresent") return `When all of: ${value.fields.join(", ")}`;
  return `Compute condition: ${value.conditionId}`;
}

function renderEnumOptions(input) {
  if (input.kind !== "enum") return "";
  const rows = input.enumValues
    .map((option) => {
      const points = option.scorable === false ? "Not scorable" : option.points ?? "—";
      return `| \`${md(option.value)}\` | ${md(option.label)} | ${md(option.description)} | ${points} |`;
    })
    .join("\n");
  return `\n<Expandable title=${yamlString(`${input.title} options`)}>\n\n| Value | Label | Description | Points |\n| --- | --- | --- | ---: |\n${rows}\n\n</Expandable>\n`;
}

function renderBands(spec) {
  const bands = [
    ...(spec.interpretationBands ?? []).map((band) => ({ output: "Primary", ...band })),
    ...Object.entries(spec.outputs).flatMap(([outputName, output]) =>
      (output.interpretationBands ?? []).map((band) => ({ output: outputName, ...band })),
    ),
  ];
  if (bands.length === 0) return "No deterministic interpretation bands are declared for this calculator.";
  return [
    "| Output | Code | Condition | Label | Kind | Severity |",
    "| --- | --- | --- | --- | --- | --- |",
    ...bands.map((band) =>
      `| ${md(band.output)} | \`${md(band.code)}\` | \`${md(band.when)}\` | ${md(band.label)} | ${md(band.kind)} | ${md(band.severity)} |`,
    ),
  ].join("\n");
}

function renderWarnings(spec) {
  const items = [];
  for (const warning of spec.warnings ?? []) {
    const scope = warning.where?.length
      ? `${warning.field} when ${warning.when}; where ${warning.where.map((entry) => `${entry.field} ${entry.when}`).join(", ")}`
      : `${warning.field} when ${warning.when}`;
    items.push(`- **${md(scope)}:** ${md(warning.message)}`);
  }
  for (const constraint of spec.constraints ?? []) {
    items.push(`- **Constraint (${md(constraint.kind)}):** ${md(constraint.message)}`);
  }
  for (const adjustment of spec.adjustments ?? []) {
    const bound = adjustment.operation === "clamp"
      ? adjustment.minimum === adjustment.maximum
        ? adjustment.minimum
        : `${adjustment.minimum}–${adjustment.maximum}`
      : adjustment.operation === "cap"
        ? adjustment.maximum
        : adjustment.minimum;
    items.push(`- **Adjustment \`${md(adjustment.id)}\`:** ${md(adjustment.operation)} at ${md(bound)} when its declared condition applies.`);
  }
  return items.length > 0 ? items.join("\n") : "No calculator-specific warning rules or cross-field constraints are declared beyond input validation and applicability.";
}

function renderEvidence(spec) {
  return [
    "| ID | Role | Citation and locator |",
    "| --- | --- | --- |",
    ...spec.evidence.map((source) => {
      const citation = source.url
        ? `[${md(source.citation)}](${source.url})`
        : md(source.citation);
      return `| \`${md(source.id)}\` | ${md(source.type)} | ${citation}<br />${md(source.locator)} |`;
    }),
  ].join("\n");
}

function selectExample(dossier, spec) {
  const preferred = (dossier?.cases ?? []).find(
    (entry) => entry.kind === "reference" && ["calculate", "warn"].includes(entry.expectedBehavior),
  ) ?? (dossier?.cases ?? []).find(
    (entry) => entry.kind === "agent" && ["calculate", "warn"].includes(entry.expectedBehavior),
  );
  if (preferred?.inputs) return preferred.inputs;

  return Object.fromEntries(
    Object.entries(spec.inputs)
      .filter(([, input]) => input.required)
      .map(([name, input]) => [name, input.examples[0]]),
  );
}

function renderPage(spec, review, dossier) {
  const example = selectExample(dossier, spec);
  const inputs = Object.entries(spec.inputs);
  const outputs = Object.entries(spec.outputs);
  const reviewDate = spec.clinicalModel.reviewDate ?? spec.reviewAfter ?? "Not declared";
  const counts = review?.counts;
  const assurance = review?.state ?? "not_available";
  const aliases = [...(spec.synonyms ?? []), ...(spec.abbreviations ?? [])];

  const inputTable = [
    "| Field | Type | Required | Default | Plausible | Hard limits | Description |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...inputs.map(([name, input]) =>
      `| \`${md(name)}\`${input.deprecated === true ? " (deprecated)" : ""} | ${md(inputType(input))} | ${input.required ? "Yes" : "No"} | ${defaultValue(input)} | ${range(input.plausible)} | ${range(input.hardLimits)} | ${md(input.description)} |`,
    ),
  ].join("\n");

  const enumDetails = inputs.map(([, input]) => renderEnumOptions(input)).filter(Boolean).join("\n");
  const outputTable = [
    "| Field | Type | Availability | Primary | Description |",
    "| --- | --- | --- | --- | --- |",
    ...outputs.map(([name, output]) =>
      `| \`${md(name)}\` | ${md(outputType(output))} | ${md(availability(output.availability))} | ${spec.primaryOutputs.includes(name) ? "Yes" : "No"} | ${md(output.description)} |`,
    ),
  ].join("\n");

  return `---
title: ${yamlString(spec.name)}
description: ${yamlString(spec.purposeForAgents)}
sidebar:
  label: ${yamlString(spec.name)}
search:
  tags: [${[spec.id, spec.clinicalModel.modelKind, ...aliases].map(yamlString).join(", ")}]
---

{/* GENERATED from repository-root OathMCP sources. Edit scripts/generate-calculators.mjs, not this page. */}

<Badge variant="success">${assurance}</Badge> <Badge>${spec.clinicalModel.modelKind}</Badge> <Badge>Spec ${spec.version}</Badge>

:::warning
This calculator provides decision support. Confirm that its declared population,
setting, model, timing, inputs, units, and limitations apply. A qualified
clinician remains responsible for interpretation and every clinical decision.
:::

## Clinical use

| Dimension | Declared contract |
| --- | --- |
| Population | ${md(spec.applicability.population)} |
| Setting | ${md(spec.applicability.setting)} |
| Model | \`${md(spec.clinicalModel.modelId)}\` · ${md(spec.clinicalModel.modelVersion)} |
| Model kind | ${md(spec.clinicalModel.modelKind)} |
| Variant | ${md(spec.variant ?? "Not separately declared")} |
| Review date | ${md(reviewDate)} |
| Review after | ${md(spec.reviewAfter ?? "Not separately declared")} |

### Exclusions and limitations

${spec.whenNotToUse ? `**When not to use:** ${md(spec.whenNotToUse)}\n\n` : ""}${spec.applicability.exclusions.length > 0 ? spec.applicability.exclusions.map((entry) => `- ${md(entry)}`).join("\n") : "No additional exclusions are declared beyond the population and setting above."}

## Inputs

${inputTable}

For \`quantity\` fields, submit an object with explicit \`value\` and \`unit\` fields.
Hard limits are operational safety envelopes, not clinical cutoffs. Values
outside plausible ranges may calculate with a warning when still within hard limits.

${enumDetails}

## Outputs

${outputTable}

## Interpretation bands

${renderBands(spec)}

## Warnings, constraints, and adjustments

${renderWarnings(spec)}

## MCP request example

The example is drawn from the source-derived validation dossier when available.
It demonstrates request shape; it is not a recommendation to use this calculator
for a particular person.

\`\`\`json title="calculate"
${JSON.stringify({ id: spec.id, inputs: example }, null, 2)}
\`\`\`

Before first use, call \`describe_calculator\` with the canonical ID \`${spec.id}\`
and compare the returned contract to this page.

## Implementation assurance

| State | Claims | Executable claims | Required scenarios | Blockers |
| --- | ---: | ---: | ---: | --- |
| \`${assurance}\` | ${counts ? `${counts.claimsSupported}/${counts.claimsTotal}` : "—"} | ${counts ? `${counts.witnessedExecutableClaims}/${counts.executableClaims}` : "—"} | ${counts ? `${counts.passedCases}/${counts.requiredCases}` : "—"} | ${review?.blockerCodes?.length ? review.blockerCodes.join(", ") : "None recorded"} |

This is repository-defined implementation assurance, not an unqualified claim
of clinical validation, regulatory approval, or suitability for an individual patient.

## Evidence

The MCP resource for this calculator is \`calc://${spec.id}/evidence\`.

${renderEvidence(spec)}

<Panel title="Repository source">
  Calculator ID \`${spec.id}\`; spec version \`${spec.version}\`; generated from
  the checked-in spec, validation dossier, and assurance state in this OathMCP
  repository. Use the evidence resource and repository history when evaluating
  source currency.
</Panel>
`;
}

async function loadSource() {
  const specDir = join(sourceRoot, "specs");
  if (!existsSync(specDir)) {
    throw new Error(`Missing repository-root OathMCP specs: ${specDir}`);
  }
  const specFiles = (await readdir(specDir)).filter((name) => name.endsWith(".yaml")).sort();
  const specs = await Promise.all(specFiles.map(async (name) =>
    YAML.parse(await readFile(join(specDir, name), "utf8")),
  ));

  const validationText = await readFile(join(sourceRoot, "src", "server", "validation-state.generated.ts"), "utf8");
  const jsonMatch = validationText.match(/=\s*(\{[\s\S]*\})\s+as const;/);
  if (!jsonMatch) throw new Error("Could not parse repository validation-state.generated.ts.");
  const reviews = JSON.parse(jsonMatch[1]);

  const dossiers = new Map();
  for (const spec of specs) {
    const path = join(sourceRoot, "validation", "calculators", `${spec.id}.yaml`);
    dossiers.set(spec.id, YAML.parse(await readFile(path, "utf8")));
  }
  return { specs, reviews, dossiers };
}

function buildFiles(specs, reviews, dossiers) {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const assigned = categories.flatMap((category) => category.ids);
  const missingAssignments = specs.map((spec) => spec.id).filter((id) => !assigned.includes(id));
  const unknownAssignments = assigned.filter((id) => !byId.has(id));
  const duplicates = assigned.filter((id, index) => assigned.indexOf(id) !== index);
  if (missingAssignments.length || unknownAssignments.length || duplicates.length) {
    throw new Error(JSON.stringify({ missingAssignments, unknownAssignments, duplicates }, null, 2));
  }

  const files = new Map();
  files.set("meta.ts", `import { defineMeta } from "blume";\n\nexport default defineMeta({\n  title: "Calculators",\n  icon: "calculator",\n  order: 2,\n  pages: ["index", ${categories.map((category) => JSON.stringify(category.slug)).join(", ")}],\n});\n`);

  const cards = categories.map((category) =>
    `  <Card title=${yamlString(category.title)} href=${yamlString(`/calculators/${category.slug}`)} icon=${yamlString(category.icon)}>\n    ${md(category.description)} ${category.ids.length} calculators.\n  </Card>`,
  ).join("\n");
  files.set("index.mdx", `---
title: Calculators
description: Clinical applicability and technical contracts for all ${specs.length} calculators in OathMCP.
---

{/* GENERATED from repository-root OathMCP sources. */}

Every page combines the declared clinical scope with the exact MCP-facing input,
output, warning, constraint, evidence, and assurance contract. Browse by domain
or use search by calculator name, abbreviation, purpose, or field.

:::warning
Catalog inclusion does not establish that a calculator is appropriate for a
particular person. Confirm the population, setting, model, variant, timing,
inputs, units, exclusions, and current governing guidance before use.
:::

<CardGroup cols={2}>
${cards}
</CardGroup>
`);

  for (const category of categories) {
    const specsInCategory = category.ids.map((id) => byId.get(id));
    files.set(`${category.slug}/meta.ts`, `import { defineMeta } from "blume";\n\nexport default defineMeta({\n  title: ${JSON.stringify(category.title)},\n  icon: ${JSON.stringify(category.icon)},\n  pages: ["index", ${category.ids.map(JSON.stringify).join(", ")}],\n});\n`);
    const list = specsInCategory.map((spec) =>
      `  <Card title=${yamlString(spec.name)} href=${yamlString(`/calculators/${category.slug}/${spec.id}`)} icon="calculator">\n    ${md(spec.purposeForAgents)}\n  </Card>`,
    ).join("\n");
    files.set(`${category.slug}/index.mdx`, `---
title: ${yamlString(category.title)}
description: ${yamlString(category.description)}
---

{/* GENERATED from repository-root OathMCP sources. */}

${md(category.description)}

<CardGroup cols={2}>
${list}
</CardGroup>
`);
    for (const spec of specsInCategory) {
      files.set(
        `${category.slug}/${spec.id}.mdx`,
        renderPage(spec, reviews[spec.id], dossiers.get(spec.id)),
      );
    }
  }
  return files;
}

async function listGeneratedFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = join(dir, entry.name);
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listGeneratedFiles(next, rel));
    else if (entry.name.endsWith(".mdx") || entry.name === "meta.ts") files.push(rel);
  }
  return files.sort();
}

async function main() {
  const { specs, reviews, dossiers } = await loadSource();
  const files = buildFiles(specs, reviews, dossiers);
  const expected = [...files.keys()].sort();

  if (checkOnly) {
    const actual = await listGeneratedFiles(outputRoot);
    const problems = [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`Generated file set differs. Expected ${expected.length}, found ${actual.length}.`);
    }
    for (const [name, content] of files) {
      const path = join(outputRoot, name);
      if (!existsSync(path) || await readFile(path, "utf8") !== content) problems.push(name);
    }
    if (problems.length) {
      throw new Error(`Calculator docs are stale:\n${problems.join("\n")}\nRun npm run generate:calculators.`);
    }
    console.log(`Generated calculator docs are current: ${specs.length} calculators, ${files.size} files.`);
    return;
  }

  await rm(outputRoot, { recursive: true, force: true });
  for (const [name, content] of files) {
    const path = join(outputRoot, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  console.log(`Generated ${specs.length} calculator pages across ${categories.length} clinical groups.`);
}

await main();
