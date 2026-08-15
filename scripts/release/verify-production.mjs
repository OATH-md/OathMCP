import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "../..");
const MODERN_PROTOCOL_VERSION = "2026-07-28";

function parseArgs(argv) {
  const options = {
    baseUrl: "https://mcp.oath.md",
    timeoutMs: 300_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base-url") {
      options.baseUrl = argv[index + 1];
      if (!options.baseUrl || options.baseUrl.startsWith("--")) throw new Error("--base-url requires a value");
      index += 1;
    } else if (token === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1]);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
        throw new Error("--timeout-ms must be a non-negative integer");
      }
      index += 1;
    } else {
      throw new Error(`Unknown option '${token}'`);
    }
  }
  return options;
}

function versionTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

function compareVersions(left, right) {
  const leftParts = versionTuple(left);
  const rightParts = versionTuple(right);
  if (!leftParts || !rightParts) throw new Error(`Invalid release version comparison: ${left}, ${right}`);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

async function loadRelease() {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const version = packageJson.version;
  const releasesDir = resolve(root, "validation", "releases");
  const attestation = YAML.parse(
    await readFile(resolve(releasesDir, `${version}.yaml`), "utf8"),
  );
  const versions = (await readdir(releasesDir))
    .map((name) => name.match(/^(\d+\.\d+\.\d+)\.yaml$/)?.[1])
    .filter(Boolean)
    .filter((candidate) => compareVersions(candidate, version) < 0)
    .sort(compareVersions);
  const previousVersion = versions.at(-1);
  const previous = previousVersion
    ? YAML.parse(await readFile(resolve(releasesDir, `${previousVersion}.yaml`), "utf8"))
    : { calculatorIds: [] };
  return {
    version,
    attestation,
    newCalculatorIds: attestation.calculatorIds.filter((id) => !previous.calculatorIds.includes(id)),
  };
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

async function calculatorDocsPaths(calculatorIds) {
  const docsRoot = resolve(root, "docs-site", "docs", "calculators");
  const pages = (await walk(docsRoot)).filter((path) => path.endsWith(".mdx"));
  return new Map(calculatorIds.map((id) => {
    const matches = pages.filter((path) => path.endsWith(`${sep}${id}.mdx`));
    if (matches.length !== 1) throw new Error(`Expected one Blume page for ${id}, found ${matches.length}`);
    const publicPath = relative(resolve(root, "docs-site", "docs"), matches[0])
      .split(sep)
      .join("/")
      .replace(/\.mdx$/u, "/");
    return [id, `/docs/${publicPath}`];
  }));
}

async function listAllResources(client) {
  const resources = [];
  let cursor;
  do {
    const page = await client.listResources(cursor === undefined ? undefined : { cursor });
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return resources;
}

async function expectedPromptNames(calculatorIds) {
  const specs = await Promise.all(calculatorIds.map(async (id) => YAML.parse(
    await readFile(resolve(root, "specs", `${id}.yaml`), "utf8"),
  )));
  return specs
    .filter((spec) => spec.prompt !== undefined)
    .map((spec) => `interpret_${spec.id}`)
    .sort();
}

function requireExactCatalog(label, actual, expected) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) === JSON.stringify(expectedSorted)) return;
  const missing = expectedSorted.filter((value) => !actualSorted.includes(value));
  const extra = actualSorted.filter((value) => !expectedSorted.includes(value));
  throw new Error(`Production ${label} mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`);
}

async function calculateNewEntries(client, calculatorIds) {
  for (const id of calculatorIds) {
    const dossier = YAML.parse(
      await readFile(resolve(root, "validation", "calculators", `${id}.yaml`), "utf8"),
    );
    const testCase = dossier.cases.find(
      (entry) => entry.kind === "reference" && ["calculate", "warn"].includes(entry.expectedBehavior),
    );
    if (!testCase) throw new Error(`No successful source-linked reference case is available for ${id}`);
    const result = await client.callTool({
      name: "calculate",
      arguments: { id, inputs: testCase.inputs },
    });
    if (result.isError === true) {
      throw new Error(`Production calculation failed for new calculator ${id} using ${testCase.id}`);
    }
    if (result.structuredContent?.result?.calculator !== id || result.structuredContent.result.ok !== true) {
      throw new Error(`Production calculation identity differs for new calculator ${id}`);
    }
  }
}

export async function verifyMcpSurface(baseUrl, release) {
  const modernClient = new Client(
    { name: "oathmcp-release-verifier-modern", version: release.version },
    { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  );
  try {
    await modernClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", baseUrl)));
    if (modernClient.getProtocolEra() !== "modern") {
      throw new Error("Production MCP verification did not negotiate the modern protocol era");
    }
    const expectedIds = [...release.attestation.calculatorIds].sort();
    const [{ tools }, { prompts }, resources, expectedPrompts] = await Promise.all([
      modernClient.listTools(),
      modernClient.listPrompts(),
      listAllResources(modernClient),
      expectedPromptNames(expectedIds),
    ]);
    const toolNames = tools.map((tool) => tool.name).sort();
    const expectedTools = ["calculate", "calculate_panel", "describe_calculator", "find_calculator"];
    requireExactCatalog("compact tool catalog", toolNames, expectedTools);
    requireExactCatalog(
      "prompt catalog",
      prompts.map((prompt) => prompt.name),
      expectedPrompts,
    );
    requireExactCatalog(
      "resource catalog",
      resources.map((resource) => resource.uri),
      [...expectedIds.map((id) => `calc://${id}/evidence`), "oath://responsible-use"],
    );

    for (const id of expectedIds) {
      const uri = `calc://${id}/evidence`;
      const [evidence, result] = await Promise.all([
        modernClient.readResource({ uri }),
        modernClient.callTool({
          name: "describe_calculator",
          arguments: { id },
        }),
      ]);
      if (!evidence.contents.some(
        (content) => content.uri === uri && "text" in content && content.text.length > 0,
      )) {
        throw new Error(`Production evidence response differs for ${id}`);
      }
      if (result.isError === true) throw new Error(`Production cannot describe ${id}`);
      if (result.structuredContent?.calculator?.id !== id) {
        throw new Error(`Production descriptor identity differs for ${id}`);
      }
    }
    await modernClient.readResource({ uri: "oath://responsible-use" });
    await calculateNewEntries(modernClient, release.newCalculatorIds);
  } finally {
    await modernClient.close();
  }

  const legacyClient = new Client(
    { name: "oathmcp-release-verifier-legacy", version: release.version },
    { versionNegotiation: { mode: "legacy" } },
  );
  try {
    await legacyClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", baseUrl)));
    if (legacyClient.getProtocolEra() !== "legacy") {
      throw new Error("Production MCP compatibility smoke did not negotiate the legacy era");
    }
    const { tools } = await legacyClient.listTools();
    if (!tools.some((tool) => tool.name === "calculate")) {
      throw new Error("Production legacy compatibility smoke is missing calculate");
    }
    await legacyClient.readResource({ uri: "oath://responsible-use" });
    const calculation = await legacyClient.callTool({
      name: "calculate",
      arguments: { id: "bmi", inputs: { weight_kg: 70, height_cm: 170 } },
    });
    if (calculation.isError === true) {
      throw new Error("Production legacy compatibility BMI smoke failed");
    }
  } finally {
    await legacyClient.close();
  }
}

async function verifyOnce(baseUrl, release) {
  const healthResponse = await fetch(new URL("/health", baseUrl), { redirect: "error" });
  if (!healthResponse.ok) throw new Error(`Health returned HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (health.version !== release.version) {
    throw new Error(`Production reports ${health.version}; expected ${release.version}`);
  }

  await verifyMcpSurface(baseUrl, release);

  const docsPaths = await calculatorDocsPaths(release.attestation.calculatorIds);
  for (const [id, path] of docsPaths) {
    const response = await fetch(new URL(path, baseUrl));
    if (!response.ok) throw new Error(`Blume page for ${id} returned HTTP ${response.status}: ${path}`);
    const spec = YAML.parse(await readFile(resolve(root, "specs", `${id}.yaml`), "utf8"));
    if (!(await response.text()).includes(spec.name)) {
      throw new Error(`Blume page for ${id} does not contain its canonical name`);
    }
  }

  const responsibleUse = await fetch(new URL("/responsible-use", baseUrl));
  if (!responsibleUse.ok) throw new Error(`Responsible Use returned HTTP ${responsibleUse.status}`);
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const release = await loadRelease();
  const startedAt = Date.now();
  let lastError;
  do {
    try {
      await verifyOnce(options.baseUrl, release);
      console.log(
        `Production verification passed: ${release.version}; ` +
        `${release.attestation.calculatorIds.length} MCP calculators; ` +
        `${release.attestation.calculatorIds.length} Blume pages; ` +
        `${release.newCalculatorIds.length} newly published calculators exercised.`,
      );
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() - startedAt >= options.timeoutMs) break;
      console.log(`Production not ready: ${error instanceof Error ? error.message : String(error)}; retrying.`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
  } while (true);

  throw lastError;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runCli();
}
