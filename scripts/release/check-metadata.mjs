import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");

function parseArgs(argv) {
  let tag;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--tag") {
      tag = argv[index + 1];
      if (!tag || tag.startsWith("--")) throw new Error("--tag requires a value");
      index += 1;
    } else {
      throw new Error(`Unknown option '${token}'`);
    }
  }
  return { tag };
}

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

const { tag } = parseArgs(process.argv.slice(2));
const packageJson = await json("package.json");
const packageLock = await json("package-lock.json");
const docsPackage = await json("docs-site/package.json");
const docsPackageLock = await json("docs-site/package-lock.json");
const version = packageJson.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json has invalid release version '${version}'`);
}
for (const [label, actual] of [
  ["package-lock.json", packageLock.version],
  ['package-lock.json packages[""]', packageLock.packages?.[""]?.version],
  ["docs-site/package.json", docsPackage.version],
  ["docs-site/package-lock.json", docsPackageLock.version],
  ['docs-site/package-lock.json packages[""]', docsPackageLock.packages?.[""]?.version],
]) {
  if (actual !== version) throw new Error(`${label} version ${actual} does not match ${version}`);
}

const attestationPath = resolve(root, "validation", "releases", `${version}.yaml`);
const attestation = YAML.parse(await readFile(attestationPath, "utf8"));
if (attestation.packageVersion !== version) {
  throw new Error(`${attestationPath} declares ${attestation.packageVersion}, expected ${version}`);
}
if (attestation.currentnessConfirmed !== true || attestation.unresolvedChanges?.length !== 0) {
  throw new Error(`release ${version} must confirm currentness with no unresolved changes`);
}

const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
if (!new RegExp(`^## ${version.replaceAll(".", "\\.")} — \\d{4}-\\d{2}-\\d{2}$`, "mu").test(changelog)) {
  throw new Error(`CHANGELOG.md is missing an exact '${version}' dated release heading`);
}

if (tag !== undefined && tag !== `v${version}`) {
  throw new Error(`release tag ${tag} does not match package version v${version}`);
}

console.log(
  `Release metadata passed: ${version}; ${attestation.calculatorIds.length} calculators; ` +
  `${Object.keys(attestation.sourceVersions).length} source versions` +
  (tag === undefined ? "." : `; tag ${tag}.`),
);
