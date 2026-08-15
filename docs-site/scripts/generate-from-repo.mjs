import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(siteRoot, "..");
const checkOnly = process.argv.includes("--check");
const responsibleUsePath = join(repositoryRoot, "docs", "RESPONSIBLE_USE.md");
const outputPath = join(siteRoot, "docs", "responsible-use.mdx");

for (const path of [
  join(repositoryRoot, "package.json"),
  join(repositoryRoot, "specs"),
  join(repositoryRoot, "validation", "calculators"),
  join(repositoryRoot, "src", "server", "validation-state.generated.ts"),
  responsibleUsePath,
]) {
  if (!existsSync(path)) throw new Error(`Missing canonical OathMCP source: ${path}`);
}

const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
if (packageJson.name !== "@oath-md/oath-mcp") {
  throw new Error(`Expected the docs site inside the OathMCP repository: ${repositoryRoot}`);
}

const canonical = await readFile(responsibleUsePath, "utf8");
const body = canonical
  .replace(/^# Responsible Use\s*/u, "")
  .replaceAll("(../LICENSE)", "(https://github.com/OATH-md/OathMCP/blob/main/LICENSE)")
  .replaceAll("(../SECURITY.md)", "(https://github.com/OATH-md/OathMCP/blob/main/SECURITY.md)");
const generated = `---
title: Responsible use
description: The clinical, deployment, privacy, warranty, and responsibility boundary for OathMCP.
sidebar:
  order: 90
  icon: heart-pulse
  hidden: true
---

{/* GENERATED from repository-root docs/RESPONSIBLE_USE.md. */}

${body.trim()}\n`;

if (checkOnly) {
  const current = existsSync(outputPath) ? await readFile(outputPath, "utf8") : "";
  if (current !== generated) {
    throw new Error("Responsible Use documentation is stale. Run npm run generate.");
  }
} else {
  await writeFile(outputPath, generated);
}

const calculatorArgs = [join(siteRoot, "scripts", "generate-calculators.mjs")];
if (checkOnly) calculatorArgs.push("--check");
const result = spawnSync(process.execPath, calculatorArgs, {
  cwd: siteRoot,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(
  checkOnly
    ? `Generated documentation matches OathMCP ${packageJson.version}.`
    : `Generated documentation from OathMCP ${packageJson.version}.`,
);
