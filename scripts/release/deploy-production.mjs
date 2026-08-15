import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  verifyProduction,
  verifyRollbackProduction,
} from './verify-production.mjs';

const root = resolve(import.meta.dirname, '../..');
const wranglerEntrypoint = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const workers = {
  mcp: { cwd: root, label: 'MCP Worker' },
  docs: { cwd: resolve(root, 'docs-site'), label: 'Blume docs Worker' },
};

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parseActiveVersion(value, label) {
  const versions = value?.versions;
  if (!Array.isArray(versions) || versions.length !== 1) {
    throw new Error(`${label} must have exactly one active production version`);
  }
  const [active] = versions;
  if (active?.percentage !== 100 || typeof active.version_id !== 'string' || active.version_id.length === 0) {
    throw new Error(`${label} must route 100% of production traffic to one version`);
  }
  return active.version_id;
}

export function parseUploadedVersionId(...outputs) {
  for (const output of outputs) {
    const match = /Worker Version ID:\s*([0-9a-f-]{36})/iu.exec(output);
    if (match) return match[1];
  }
  throw new Error('Wrangler upload did not report a Worker Version ID');
}

export function parseDeployArgs(argv) {
  const options = { baseUrl: 'https://mcp.oath.md' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--tag' || token === '--sha' || token === '--base-url') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      options[token.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option '${token}'`);
    }
  }
  if (!/^v\d+\.\d+\.\d+$/u.test(options.tag ?? '')) {
    throw new Error('--tag must be a vX.Y.Z release tag');
  }
  if (!/^[0-9a-f]{40}$/iu.test(options.sha ?? '')) {
    throw new Error('--sha must be the full 40-character release commit');
  }
  return options;
}

export function runWranglerCommand({
  args,
  cwd,
  quiet = false,
  env = process.env,
  spawnImpl = spawn,
  stderr = process.stderr,
  stdout = process.stdout,
  timeoutMs = 120_000,
}) {
  const child = spawnImpl(
    process.execPath,
    [wranglerEntrypoint, ...args],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
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
    if (!quiet) stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrOutput += text;
    if (!quiet) stderr.write(text);
  });
  return new Promise((resolvePromise, reject) => {
    child.once('error', (error) => {
      clearTimers();
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimers();
      if (timedOut) {
        reject(new Error(`Wrangler command timed out after ${timeoutMs} ms`));
        return;
      }
      if (signal !== null) {
        reject(new Error(`Wrangler terminated by ${signal}`));
        return;
      }
      resolvePromise({ exitCode: code ?? 1, stderr: stderrOutput, stdout: stdoutOutput });
    });
  });
}

function requireWranglerSuccess(result, operation) {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed with exit code ${result.exitCode}`);
  }
  return result;
}

function rejectWhenAborted(signal, message) {
  return new Promise((_, reject) => {
    function onAbort() {
      reject(signal.reason ?? new Error(message));
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function deploymentVersion(worker, runWrangler) {
  const result = requireWranglerSuccess(
    await runWrangler({ cwd: worker.cwd, args: ['deployments', 'status', '--json'], quiet: true }),
    `Reading ${worker.label} deployment`,
  );
  let status;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Wrangler returned invalid deployment JSON for ${worker.label}`);
  }
  return parseActiveVersion(status, worker.label);
}

async function uploadVersion(worker, { tag, sha }, runWrangler) {
  const result = requireWranglerSuccess(
    await runWrangler({
      cwd: worker.cwd,
      args: [
        'versions', 'upload',
        '--tag', tag,
        '--message', `${worker.label} ${tag} (${sha})`,
        '--keep-vars',
        '--strict',
      ],
    }),
    `Uploading ${worker.label}`,
  );
  return parseUploadedVersionId(result.stdout, result.stderr);
}

async function promoteVersion(worker, versionId, { tag, sha }, runWrangler) {
  requireWranglerSuccess(
    await runWrangler({
      cwd: worker.cwd,
      args: [
        'versions', 'deploy', `${versionId}@100`, '-y',
        '--message', `${worker.label} ${tag} (${sha})`,
      ],
    }),
    `Promoting ${worker.label}`,
  );
}

async function rollbackVersion(worker, versionId, { tag, sha }, runWrangler) {
  requireWranglerSuccess(
    await runWrangler({
      cwd: worker.cwd,
      args: [
        'rollback', versionId, '-y',
        '--message', `Automatic rollback after failed ${tag} deployment (${sha})`,
      ],
    }),
    `Rolling back ${worker.label}`,
  );
}

async function fetchOk(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response;
}

export async function readHealthVersion(baseUrl, fetchImpl = fetch) {
  const response = await fetchOk(fetchImpl, new URL('/health', baseUrl), 'Health');
  const health = await response.json();
  if (typeof health?.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(health.version)) {
    throw new Error('Health response did not include a semantic version');
  }
  return health.version;
}

export function createContinuityMonitor({
  baseUrl,
  fetchImpl = fetch,
  intervalMs = 1_000,
  probe = async () => {
    await Promise.all([
      fetchOk(fetchImpl, new URL('/health', baseUrl), 'Continuity health probe'),
      fetchOk(fetchImpl, new URL('/docs/', baseUrl), 'Continuity docs probe'),
    ]);
  },
} = {}) {
  let stopped = false;
  let failure;
  let timer;
  let wake;
  let settleReady;
  let rejectReady;
  let reportFailure;
  const ready = new Promise((resolvePromise, reject) => {
    settleReady = resolvePromise;
    rejectReady = reject;
  });
  const failed = new Promise((resolvePromise) => {
    reportFailure = resolvePromise;
  });
  let firstProbe = true;

  const loop = (async () => {
    while (!stopped) {
      try {
        await probe();
        if (firstProbe) settleReady();
      } catch (error) {
        failure = new Error(`Production continuity probe failed: ${messageFrom(error)}`);
        reportFailure(failure);
        if (firstProbe) rejectReady(failure);
        return;
      } finally {
        firstProbe = false;
      }
      if (stopped) return;
      await new Promise((resolvePromise) => {
        wake = resolvePromise;
        timer = setTimeout(resolvePromise, intervalMs);
      });
      timer = undefined;
      wake = undefined;
    }
  })();

  return {
    ready,
    failed,
    assertHealthy() {
      if (failure) throw failure;
    },
    async stop({ assertHealthy = true } = {}) {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      wake?.();
      await loop;
      if (assertHealthy && failure) throw failure;
    },
  };
}

async function writeGithubOutputs(path, values) {
  if (!path) return;
  const output = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  await appendFile(path, output, 'utf8');
}

async function rollbackDeployment({
  changed,
  previous,
  release,
  baseUrl,
  runWrangler,
  verifyRollback,
}) {
  const errors = [];
  for (const key of ['mcp', 'docs']) {
    if (!changed[key]) continue;
    try {
      await rollbackVersion(workers[key], previous[key], release, runWrangler);
    } catch (error) {
      errors.push(error);
    }
  }

  for (const key of ['mcp', 'docs']) {
    try {
      const active = await deploymentVersion(workers[key], runWrangler);
      if (active !== previous[key]) {
        throw new Error(`${workers[key].label} rollback left ${active} active; expected ${previous[key]}`);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    await verifyRollback({ baseUrl, expectedVersion: previous.healthVersion });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Automatic production rollback did not complete cleanly');
  }
}

export async function restoreProduction({
  tag,
  sha,
  mcpVersionId,
  docsVersionId,
  expectedVersion,
  baseUrl = 'https://mcp.oath.md',
} = {}, {
  runWrangler = runWranglerCommand,
  verifyRollbackImpl = verifyRollbackProduction,
  log = console.log,
} = {}) {
  if (!/^v\d+\.\d+\.\d+$/u.test(tag ?? '')) throw new Error('A vX.Y.Z release tag is required');
  if (!/^[0-9a-f]{40}$/iu.test(sha ?? '')) throw new Error('A full release commit SHA is required');
  for (const [label, value] of [
    ['MCP version ID', mcpVersionId],
    ['docs version ID', docsVersionId],
  ]) {
    if (!/^[0-9a-f-]{36}$/iu.test(value ?? '')) throw new Error(`${label} is required`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(expectedVersion ?? '')) {
    throw new Error('An expected X.Y.Z health version is required');
  }
  await rollbackDeployment({
    changed: { mcp: true, docs: true },
    previous: {
      mcp: mcpVersionId,
      docs: docsVersionId,
      healthVersion: expectedVersion,
    },
    release: { tag, sha },
    baseUrl,
    runWrangler,
    verifyRollback: verifyRollbackImpl,
  });
  log(
    `Production restored after npm release failure: MCP ${mcpVersionId}; ` +
    `docs ${docsVersionId}; health ${expectedVersion}.`,
  );
}

export async function deployProduction({
  tag,
  sha,
  baseUrl = 'https://mcp.oath.md',
  githubOutput = process.env.GITHUB_OUTPUT,
} = {}, {
  runWrangler = runWranglerCommand,
  fetchImpl = fetch,
  monitorFactory = createContinuityMonitor,
  verifyProductionImpl = verifyProduction,
  verifyRollbackImpl = verifyRollbackProduction,
  writeOutputs = writeGithubOutputs,
  log = console.log,
} = {}) {
  if (!/^v\d+\.\d+\.\d+$/u.test(tag ?? '')) throw new Error('A vX.Y.Z release tag is required');
  if (!/^[0-9a-f]{40}$/iu.test(sha ?? '')) throw new Error('A full release commit SHA is required');
  const release = { tag, sha };

  const previous = {
    mcp: await deploymentVersion(workers.mcp, runWrangler),
    docs: await deploymentVersion(workers.docs, runWrangler),
    healthVersion: await readHealthVersion(baseUrl, fetchImpl),
  };
  log(
    `Captured production baseline: MCP ${previous.mcp}; docs ${previous.docs}; ` +
    `health ${previous.healthVersion}.`,
  );

  const uploaded = {
    mcp: await uploadVersion(workers.mcp, release, runWrangler),
    docs: await uploadVersion(workers.docs, release, runWrangler),
  };
  log(`Uploaded without changing traffic: MCP ${uploaded.mcp}; docs ${uploaded.docs}.`);

  const changed = { docs: false, mcp: false };
  const monitor = monitorFactory({ baseUrl, fetchImpl });
  try {
    await monitor.ready;

    changed.docs = true;
    await promoteVersion(workers.docs, uploaded.docs, release, runWrangler);
    await fetchOk(fetchImpl, new URL('/docs/', baseUrl), 'Promoted Blume docs');
    monitor.assertHealthy();

    changed.mcp = true;
    await promoteVersion(workers.mcp, uploaded.mcp, release, runWrangler);
    monitor.assertHealthy();

    const verificationAbort = new AbortController();
    const verificationDeadline = AbortSignal.timeout(360_000);
    const verificationSignal = AbortSignal.any([
      verificationAbort.signal,
      verificationDeadline,
    ]);
    const verification = verifyProductionImpl({
      baseUrl,
      signal: verificationSignal,
      timeoutMs: 300_000,
    });
    try {
      await Promise.race([
        verification,
        monitor.failed.then((failure) => { throw failure; }),
        rejectWhenAborted(verificationDeadline, 'Production verification timed out'),
      ]);
    } catch (error) {
      verificationAbort.abort();
      void verification.catch(() => undefined);
      throw error;
    }
    monitor.assertHealthy();

    const active = {
      mcp: await deploymentVersion(workers.mcp, runWrangler),
      docs: await deploymentVersion(workers.docs, runWrangler),
    };
    if (active.mcp !== uploaded.mcp || active.docs !== uploaded.docs) {
      throw new Error(
        `Production version confirmation failed: MCP ${active.mcp}; docs ${active.docs}`,
      );
    }
    await monitor.stop();

    const outputs = {
      mcp_version_id: uploaded.mcp,
      docs_version_id: uploaded.docs,
      previous_mcp_version_id: previous.mcp,
      previous_docs_version_id: previous.docs,
      previous_version: previous.healthVersion,
    };
    await writeOutputs(githubOutput, outputs);
    log(`Production cutover verified: MCP ${uploaded.mcp}; docs ${uploaded.docs}.`);
    return outputs;
  } catch (error) {
    await monitor.stop({ assertHealthy: false });
    if (!changed.mcp && !changed.docs) throw error;
    try {
      await rollbackDeployment({
        changed,
        previous,
        release,
        baseUrl,
        runWrangler,
        verifyRollback: verifyRollbackImpl,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Production deployment failed and rollback needs attention: ${messageFrom(error)}`,
      );
    }
    throw new Error(`Production deployment failed and was rolled back: ${messageFrom(error)}`, {
      cause: error,
    });
  }
}

async function runCli() {
  const options = parseDeployArgs(process.argv.slice(2));
  await deployProduction(options);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runCli();
}
