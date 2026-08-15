import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parsePublishArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--sha' || token === '--timeout-ms') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      options[token.slice(2).replace('-ms', 'Ms')] = token === '--timeout-ms' ? Number(value) : value;
      index += 1;
    } else {
      throw new Error(`Unknown option '${token}'`);
    }
  }
  if (!/^[0-9a-f]{40}$/iu.test(options.sha ?? '')) {
    throw new Error('--sha must be the full 40-character release commit');
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return options;
}

export function runNpmCommand({
  args,
  cwd = root,
  env = process.env,
  spawnImpl = spawn,
  stderr = process.stderr,
  stdout = process.stdout,
  timeoutMs = 600_000,
}) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrOutput = '';
  let stdoutOutput = '';
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
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutOutput += text;
    stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrOutput += text;
    stderr.write(text);
  });
  return new Promise((resolvePromise, reject) => {
    child.once('error', (error) => {
      clearTimers();
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(`npm command timed out after ${timeoutMs} ms`));
        return;
      }
      if (signal !== null) {
        reject(new Error(`npm command terminated by ${signal}`));
        return;
      }
      resolvePromise({ exitCode: code ?? 1, stderr: stderrOutput, stdout: stdoutOutput });
    });
  });
}

function registryPackageUrl(registry, packageName) {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  return new URL(encodeURIComponent(packageName), base);
}

export async function readRegistryPackage({
  packageName,
  registry = DEFAULT_REGISTRY,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(registryPackageUrl(registry, packageName), {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  return response.json();
}

export function validatePublishedVersion(packument, { packageName, version, sha }) {
  const published = packument?.versions?.[version];
  if (published === undefined) return undefined;
  if (published.name !== packageName || published.version !== version) {
    throw new Error(`npm registry returned unexpected metadata for ${packageName}@${version}`);
  }
  if (published.gitHead !== sha) {
    throw new Error(
      `${packageName}@${version} was published from ${String(published.gitHead)}; expected ${sha}`,
    );
  }
  const integrity = published.dist?.integrity;
  const tarball = published.dist?.tarball;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error(`${packageName}@${version} is missing SHA-512 registry integrity`);
  }
  if (typeof tarball !== 'string' || !tarball.startsWith('https://registry.npmjs.org/')) {
    throw new Error(`${packageName}@${version} is missing its registry tarball URL`);
  }
  if (packument?.['dist-tags']?.latest !== version) {
    return { pendingLatest: true };
  }
  return { integrity, tarball };
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readPackageMetadata(projectRoot) {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  const { name, version, publishConfig } = packageJson;
  if (typeof name !== 'string' || !name.startsWith('@') || !name.includes('/')) {
    throw new Error('package.json must declare an organization-scoped package name');
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('package.json must declare an exact X.Y.Z version');
  }
  const registry = publishConfig?.registry ?? DEFAULT_REGISTRY;
  if (registry !== DEFAULT_REGISTRY || publishConfig?.access !== 'public') {
    throw new Error('package.json must publish publicly to https://registry.npmjs.org/');
  }
  return { name, registry, version };
}

async function writeGithubOutputs(path, values) {
  if (!path) return;
  const output = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  await appendFile(path, output, 'utf8');
}

export async function publishNpm({
  sha,
  timeoutMs = 120_000,
  githubOutput = process.env.GITHUB_OUTPUT,
  projectRoot = root,
} = {}, {
  fetchImpl = fetch,
  runNpm = runNpmCommand,
  sleep = delay,
  writeOutputs = writeGithubOutputs,
  log = console.log,
} = {}) {
  if (!/^[0-9a-f]{40}$/iu.test(sha ?? '')) throw new Error('A full release commit SHA is required');
  const metadata = await readPackageMetadata(projectRoot);
  const expected = { packageName: metadata.name, version: metadata.version, sha };
  let packument = await readRegistryPackage({
    packageName: metadata.name,
    registry: metadata.registry,
    fetchImpl,
  });
  let published = validatePublishedVersion(packument, expected);
  let publishFailure;

  if (published === undefined) {
    const result = await runNpm({
      args: ['publish', '--access', 'public'],
      cwd: projectRoot,
    });
    if (result.exitCode !== 0) {
      publishFailure = new Error(`npm publish failed with exit code ${result.exitCode}`);
      log(`${publishFailure.message}; checking whether the registry accepted the package.`);
    }
  } else if (!published.pendingLatest) {
    log(`${metadata.name}@${metadata.version} is already published from ${sha}.`);
  }

  const deadline = Date.now() + timeoutMs;
  while (published === undefined || published.pendingLatest) {
    if (Date.now() >= deadline) {
      const detail = publishFailure === undefined ? '' : `: ${messageFrom(publishFailure)}`;
      throw new Error(`npm registry did not confirm ${metadata.name}@${metadata.version}${detail}`);
    }
    await sleep(Math.min(2_000, Math.max(1, deadline - Date.now())));
    packument = await readRegistryPackage({
      packageName: metadata.name,
      registry: metadata.registry,
      fetchImpl,
    });
    published = validatePublishedVersion(packument, expected);
  }

  const outputs = {
    package_name: metadata.name,
    package_version: metadata.version,
    package_integrity: published.integrity,
    package_tarball: published.tarball,
  };
  await writeOutputs(githubOutput, outputs);
  log(`npm publication verified: ${metadata.name}@${metadata.version} (${sha}).`);
  return outputs;
}

async function runCli() {
  const options = parsePublishArgs(process.argv.slice(2));
  await publishNpm(options);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runCli();
}
