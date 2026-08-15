import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FREE_LIMIT_BYTES = 3 * 1024 ** 2;

export function parseGzipSize(...outputs) {
  const match = outputs
    .map((output) => output.match(
      /Total Upload[^\r\n]*\/\s*gzip:\s*([\d.]+)\s*(KiB|MiB)/i,
    ))
    .find((candidate) => candidate !== null);
  if (!match) {
    throw new Error('Wrangler output did not report a gzip bundle size');
  }

  const value = Number(match[1]);
  const unit = match[2];
  const bytes = value * (unit.toLowerCase() === 'mib' ? 1024 ** 2 : 1024);
  if (!Number.isFinite(bytes)) {
    throw new Error(`Wrangler reported an invalid gzip bundle size: ${match[1]} ${unit}`);
  }
  return { bytes, unit, value };
}

export function assertBelowFreeLimit(size) {
  if (size.bytes >= FREE_LIMIT_BYTES) {
    throw new Error(
      `Worker gzip bundle must remain below 3 MiB; received ${size.value} ${size.unit}`,
    );
  }
}

function runWranglerDryRun({
  npmExecPath = process.env.npm_execpath,
  spawnImpl = spawn,
  stderr = process.stderr,
  stdout = process.stdout,
} = {}) {
  if (!npmExecPath) {
    throw new Error('npm_execpath is required; run this check through npm');
  }

  const child = spawnImpl(
    process.execPath,
    [npmExecPath, 'exec', '--', 'wrangler', 'deploy', '--dry-run'],
    { env: process.env, stdio: ['inherit', 'pipe', 'pipe'] },
  );
  let stderrOutput = '';
  let stdoutOutput = '';

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

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Wrangler dry run terminated by ${signal}`));
        return;
      }
      resolve({ exitCode: code ?? 1, stderr: stderrOutput, stdout: stdoutOutput });
    });
  });
}

export async function checkWorkerBundle({
  log = console.log,
  runWrangler = runWranglerDryRun,
} = {}) {
  const result = await runWrangler();
  if (result.exitCode !== 0) {
    return result.exitCode;
  }

  const size = parseGzipSize(result.stdout, result.stderr);
  assertBelowFreeLimit(size);
  log(`Worker gzip bundle: ${size.value} ${size.unit} (limit: < 3 MiB)`);
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  process.exitCode = await checkWorkerBundle();
}
