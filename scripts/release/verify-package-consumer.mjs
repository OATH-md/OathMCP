import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = resolve(import.meta.dirname, '../..');
const PACKAGE_NAME = '@oath-md/oath-mcp';
const MODERN_PROTOCOL_VERSION = '2026-07-28';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--package-spec') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      options.packageSpec = value;
      index += 1;
    } else {
      throw new Error(`Unknown option '${token}'`);
    }
  }
  return options;
}

function runCommand(command, args, {
  cwd,
  env = process.env,
  timeoutMs = 300_000,
} = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  let timedOut = false;
  let forceKillTimer;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  }, timeoutMs);
  const clearTimers = () => {
    clearTimeout(timeout);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  };
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolvePromise, reject) => {
    child.once('error', (error) => {
      clearTimers();
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs} ms`));
      } else if (signal !== null) {
        reject(new Error(`${command} terminated by ${signal}`));
      } else {
        resolvePromise({ exitCode: code ?? 1, stderr, stdout });
      }
    });
  });
}

function requireSuccess(result, operation) {
  if (result.exitCode !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
    throw new Error(`${operation} failed with exit code ${result.exitCode}: ${detail}`);
  }
  return result;
}

async function packLocalPackage(temporaryRoot) {
  const packDirectory = join(temporaryRoot, 'pack');
  await mkdir(packDirectory);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = requireSuccess(await runCommand(npm, [
    'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory,
  ], {
    cwd: root,
    env: { ...process.env, npm_config_dry_run: 'false' },
  }), 'Packing the release candidate');
  const manifest = JSON.parse(result.stdout);
  const filename = manifest?.[0]?.filename;
  if (typeof filename !== 'string' || !filename.endsWith('.tgz')) {
    throw new Error('npm pack did not return a tarball filename');
  }
  return join(packDirectory, basename(filename));
}

async function verifyExports(consumerRoot) {
  const runtimeVerifier = join(consumerRoot, 'verify-exports.mjs');
  await writeFile(runtimeVerifier, `
import { run } from '${PACKAGE_NAME}';
import { buildServer } from '${PACKAGE_NAME}/server';

if (typeof run !== 'function') throw new Error('${PACKAGE_NAME} did not export run()');
if (typeof buildServer !== 'function') {
  throw new Error('${PACKAGE_NAME}/server did not export buildServer()');
}
const bmi = run('bmi', { weight_kg: 70, height_cm: 170 });
if (bmi?.results?.find(({ name }) => name === 'bmi')?.value !== 24.22) {
  throw new Error('Installed engine BMI smoke did not return 24.22');
}
buildServer();
`, 'utf8');
  requireSuccess(
    await runCommand(process.execPath, [runtimeVerifier], { cwd: consumerRoot }),
    'Verifying installed JavaScript exports',
  );

  const typeVerifier = join(consumerRoot, 'verify-types.ts');
  await writeFile(typeVerifier, `
import { run } from '${PACKAGE_NAME}';
import { buildServer } from '${PACKAGE_NAME}/server';

const result = run('bmi', { weight_kg: 70, height_cm: 170 });
const server = buildServer();
void result;
void server;
`, 'utf8');
  requireSuccess(await runCommand(process.execPath, [
    join(consumerRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit',
    '--strict',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    typeVerifier,
  ], { cwd: consumerRoot }), 'Verifying installed TypeScript declarations');
}

async function verifyInstalledPackageHygiene(consumerRoot) {
  const packageRoot = join(consumerRoot, 'node_modules', '@oath-md', 'oath-mcp');
  const files = await readdir(packageRoot, { recursive: true });
  const normalized = files.map((path) => path.replaceAll('\\', '/'));
  for (const required of ['LICENSE', 'NOTICE']) {
    if (!normalized.includes(required)) throw new Error(`Installed package is missing ${required}`);
  }
  for (const path of normalized) {
    if (/^(?:\.[^/]+|drafts|reports)(?:\/|$)/u.test(path)) {
      throw new Error(`Installed package contains local workflow material: ${path}`);
    }
    if (/(?:^|\/)(?:private|credentials?)(?:\/|$)/iu.test(path)
      || /(?:^|\/)\.env(?:\.|$)/iu.test(path)
      || /(?:^|\/)[^/]*(?:credential|secret)[^/]*$/iu.test(path)) {
      throw new Error(`Installed package contains a private or credential-like path: ${path}`);
    }
  }
}

function stdioTransport(consumerRoot) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return new StdioClientTransport({
    command,
    args: ['exec', '--offline', '--prefix', consumerRoot, '--', 'oath-mcp'],
    cwd: consumerRoot,
    stderr: 'pipe',
  });
}

function expectSuccessfulCalculation(result, calculator) {
  if (result?.isError === true || !Array.isArray(result?.structuredContent?.results)) {
    throw new Error(`Installed ${calculator} calculation failed`);
  }
  if (result.structuredContent.id !== calculator) {
    throw new Error(`Installed calculation returned the wrong calculator for ${calculator}`);
  }
}

async function verifyModernClient(consumerRoot) {
  const transport = stdioTransport(consumerRoot);
  const client = new Client(
    { name: 'oathmcp-packed-consumer-modern', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const calculatorTools = listed.tools.filter(
      ({ name }) => name.startsWith('calculate_') && name !== 'calculate_panel',
    );
    if (calculatorTools.length !== 40) {
      throw new Error(`Installed catalog exposed ${calculatorTools.length} calculators; expected 40`);
    }
    for (const name of ['calculate_bmi', 'calculate_fib4', 'find_calculator', 'describe_calculator']) {
      if (!listed.tools.some((tool) => tool.name === name)) throw new Error(`Installed catalog is missing ${name}`);
    }
    const bmi = await client.callTool({
      name: 'calculate_bmi',
      arguments: { weight_kg: 70, height_cm: 170 },
    });
    expectSuccessfulCalculation(bmi, 'bmi');
    const fib4 = await client.callTool({
      name: 'calculate_fib4',
      arguments: {
        age: 35,
        ast: 75,
        alt: 100,
        platelet_count: 263,
        assessment_context: 'stable_ambulatory',
      },
    });
    expectSuccessfulCalculation(fib4, 'fib4');
    const evidence = await client.readResource({ uri: 'calc://bmi/evidence' });
    if (!Array.isArray(evidence.contents) || evidence.contents.length === 0) {
      throw new Error('Installed BMI evidence resource was empty');
    }
  } finally {
    await client.close();
  }
}

async function verifyLegacyClient(consumerRoot) {
  const transport = stdioTransport(consumerRoot);
  const client = new Client(
    { name: 'oathmcp-packed-consumer-legacy', version: '0.0.0' },
    { versionNegotiation: { mode: 'legacy' } },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (!listed.tools.some(({ name }) => name === 'calculate_bmi')) {
      throw new Error('Installed legacy catalog is missing calculate_bmi');
    }
    const bmi = await client.callTool({
      name: 'calculate_bmi',
      arguments: { weight_kg: 70, height_cm: 170 },
    });
    expectSuccessfulCalculation(bmi, 'bmi');
  } finally {
    await client.close();
  }
}

async function verifyRuntimeAudit(consumerRoot) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await runCommand(npm, ['audit', '--omit=dev', '--audit-level=low', '--json'], {
    cwd: consumerRoot,
    env: { ...process.env, npm_config_dry_run: 'false' },
  });
  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Installed runtime audit returned invalid JSON: ${result.stderr.trim()}`);
  }
  const total = audit?.metadata?.vulnerabilities?.total;
  if (result.exitCode !== 0 || total !== 0) {
    throw new Error(`Installed runtime audit reported ${String(total)} vulnerabilities`);
  }
}

export async function verifyPackageConsumer({ packageSpec } = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'oathmcp-package-consumer-'));
  const consumerRoot = join(temporaryRoot, 'consumer');
  try {
    await mkdir(consumerRoot);
    await writeFile(join(consumerRoot, 'package.json'), `${JSON.stringify({
      name: 'oathmcp-package-consumer',
      private: true,
      type: 'module',
      devDependencies: {
        '@types/node': '^22',
        typescript: '^5',
      },
    }, null, 2)}\n`, 'utf8');
    const installSpec = packageSpec ?? await packLocalPackage(temporaryRoot);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    requireSuccess(await runCommand(npm, [
      'install', '--ignore-scripts', '--no-fund', installSpec,
    ], {
      cwd: consumerRoot,
      env: { ...process.env, npm_config_dry_run: 'false' },
    }), 'Installing the release candidate');
    const installed = JSON.parse(await readFile(join(
      consumerRoot, 'node_modules', '@oath-md', 'oath-mcp', 'package.json',
    ), 'utf8'));
    if (installed.name !== PACKAGE_NAME) throw new Error(`Installed package name was ${String(installed.name)}`);
    if (installed.bin?.['oath-mcp'] !== 'dist/server/stdio.js') {
      throw new Error('Installed package did not expose the oath-mcp executable');
    }
    await verifyInstalledPackageHygiene(consumerRoot);
    await verifyExports(consumerRoot);
    await verifyModernClient(consumerRoot);
    await verifyLegacyClient(consumerRoot);
    await verifyRuntimeAudit(consumerRoot);
    console.log(
      `Packed consumer verification passed: ${PACKAGE_NAME}@${installed.version}; ` +
      '40 calculators; modern and legacy stdio; exports and declarations; ' +
      'evidence; package hygiene; runtime audit.',
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runCli() {
  await verifyPackageConsumer(parseArgs(process.argv.slice(2)));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runCli();
}
