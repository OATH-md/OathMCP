import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "..");
const specFiles = (await readdir(join(sourceRoot, "specs"))).filter((name) => name.endsWith(".yaml")).sort();
const specs = await Promise.all(specFiles.map(async (name) => YAML.parse(await readFile(join(sourceRoot, "specs", name), "utf8"))));

if (specs.length !== 40) throw new Error(`Expected 40 calculators, found ${specs.length}. Update the site contract deliberately.`);

const generated = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".mdx")) generated.push(path);
  }
}
await walk(join(root, "docs", "calculators"));

for (const spec of specs) {
  const page = generated.find((path) => path.endsWith(`/${spec.id}.mdx`));
  if (!page) throw new Error(`Missing generated page for ${spec.id}.`);
  const content = await readFile(page, "utf8");
  for (const required of [spec.name, spec.purposeForAgents, `calc://${spec.id}/evidence`, spec.clinicalModel.modelVersion]) {
    if (!content.includes(required)) throw new Error(`${page} is missing required source content: ${required}`);
  }
  for (const [name, input] of Object.entries(spec.inputs)) {
    if (input.deprecated === true && !content.includes(`\`${name}\` (deprecated)`)) {
      throw new Error(`${page} does not identify deprecated input ${name}.`);
    }
  }
  for (const adjustment of spec.adjustments ?? []) {
    const bound = adjustment.operation === "clamp"
      ? adjustment.minimum === adjustment.maximum
        ? adjustment.minimum
        : `${adjustment.minimum}–${adjustment.maximum}`
      : adjustment.operation === "cap"
        ? adjustment.maximum
        : adjustment.minimum;
    if (!content.includes(`at ${bound} when its declared condition applies`)) {
      throw new Error(`${page} does not document adjustment ${adjustment.id} with its operation-specific bound.`);
    }
  }
}

const responsibleUse = await readFile(join(root, "docs", "responsible-use.mdx"), "utf8");
const normalizedResponsibleUse = responsibleUse.replace(/\s+/g, " ");
for (const phrase of [
  "does not provide medical advice, diagnosis, prognosis, or treatment",
  "The clinician using a result remains responsible",
  "OathMCP is not an emergency service",
  "Do not send protected or personal health information",
  "provided **as is** and **as available**",
]) {
  if (!normalizedResponsibleUse.includes(phrase)) throw new Error(`Responsible Use page is missing canonical phrase: ${phrase}`);
}

const config = await readFile(join(root, "blume.config.ts"), "utf8");
if (!config.includes('output: "static"')) throw new Error("Documentation deployment must remain static by default.");
if (!config.includes('base: "/docs"')) throw new Error("Documentation must remain mounted at /docs.");
if (!config.includes('site: "https://mcp.oath.md"')) throw new Error("Documentation canonical URLs must use mcp.oath.md.");
if (!config.match(/mcp:\s*\{\s*enabled:\s*false/s)) throw new Error("Blume documentation MCP must remain disabled.");
if (config.includes("ask:")) throw new Error("Blume Ask AI must remain disabled until explicitly designed and operated.");

const wrangler = await readFile(join(root, "wrangler.jsonc"), "utf8");
for (const route of ['"pattern": "mcp.oath.md/docs"', '"pattern": "mcp.oath.md/docs/*"']) {
  if (!wrangler.includes(route)) throw new Error(`Missing Cloudflare documentation route: ${route}`);
}

const headers = await readFile(join(root, "public", "_headers"), "utf8");
for (const required of [
  "/docs",
  "/docs/*",
  "Strict-Transport-Security: max-age=31536000; includeSubDomains",
  "X-Content-Type-Options: nosniff",
  "Content-Type: text/markdown; charset=utf-8",
]) {
  if (!headers.includes(required)) throw new Error(`Documentation security headers are missing: ${required}`);
}

console.log(`Content checks passed: ${specs.length} calculators, canonical responsibility notice, static-only AI posture.`);
