import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  createContinuityMonitor,
  deployProduction,
  parseActiveVersion,
  parseUploadedVersionId,
  restoreProduction,
  runWranglerCommand,
} from '../../scripts/release/deploy-production.mjs';

const SHA = 'a'.repeat(40);
const PREVIOUS = {
  mcp: '11111111-1111-4111-8111-111111111111',
  docs: '22222222-2222-4222-8222-222222222222',
};
const UPLOADED = {
  mcp: '33333333-3333-4333-8333-333333333333',
  docs: '44444444-4444-4444-8444-444444444444',
};

function workerKey(cwd: string): keyof typeof PREVIOUS {
  return cwd.endsWith('docs-site') ? 'docs' : 'mcp';
}

function response(body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function createHarness({
  fail,
  splitMcp = false,
}: {
  fail?: (event: string) => boolean;
  splitMcp?: boolean;
} = {}) {
  const events: string[] = [];
  const active = { ...PREVIOUS };
  const runWrangler = vi.fn(async ({ args, cwd }: { args: string[]; cwd: string }) => {
    const key = workerKey(cwd);
    const event = `${key}:${args.join(' ')}`;
    events.push(event);

    if (args[0] === 'deployments') {
      const versions = splitMcp && key === 'mcp' && active.mcp === PREVIOUS.mcp
        ? [
            { version_id: PREVIOUS.mcp, percentage: 50 },
            { version_id: UPLOADED.mcp, percentage: 50 },
          ]
        : [{ version_id: active[key], percentage: 100 }];
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ versions }) };
    }
    if (args[0] === 'versions' && args[1] === 'upload') {
      if (fail?.(event)) return { exitCode: 1, stderr: 'upload failed', stdout: '' };
      return { exitCode: 0, stderr: '', stdout: `Worker Version ID: ${UPLOADED[key]}\n` };
    }
    if (args[0] === 'versions' && args[1] === 'deploy') {
      active[key] = UPLOADED[key];
      if (fail?.(event)) return { exitCode: 1, stderr: 'promotion failed', stdout: '' };
      return { exitCode: 0, stderr: '', stdout: 'deployed' };
    }
    if (args[0] === 'rollback') {
      if (fail?.(event)) return { exitCode: 1, stderr: 'rollback failed', stdout: '' };
      active[key] = PREVIOUS[key];
      return { exitCode: 0, stderr: '', stdout: 'rolled back' };
    }
    throw new Error(`Unexpected Wrangler command: ${event}`);
  });
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname === '/health') {
      return response(JSON.stringify({ version: '0.1.0' }), 'application/json');
    }
    return response('ok');
  }) as unknown as typeof fetch;
  const monitor = {
    ready: Promise.resolve(),
    failed: new Promise<Error>(() => undefined),
    assertHealthy: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const monitorFactory = vi.fn(() => monitor);
  const verifyProductionImpl = vi.fn(async (
    _options: { baseUrl: string | URL; signal: AbortSignal; timeoutMs: number },
  ) => undefined);
  const verifyRollbackImpl = vi.fn(async () => undefined);
  const writeOutputs = vi.fn(async () => undefined);

  return {
    active,
    events,
    fetchImpl,
    monitor,
    monitorFactory,
    runWrangler,
    verifyProductionImpl,
    verifyRollbackImpl,
    writeOutputs,
  };
}

async function execute(harness: ReturnType<typeof createHarness>) {
  return deployProduction(
    { tag: 'v0.2.0', sha: SHA, githubOutput: '/tmp/github-output' },
    { ...harness, log: vi.fn() },
  );
}

describe('rollback-safe production deployment', () => {
  it('requires a single version receiving all production traffic', () => {
    expect(parseActiveVersion({
      versions: [{ version_id: PREVIOUS.mcp, percentage: 100 }],
    }, 'MCP Worker')).toBe(PREVIOUS.mcp);
    expect(() => parseActiveVersion({
      versions: [
        { version_id: PREVIOUS.mcp, percentage: 50 },
        { version_id: UPLOADED.mcp, percentage: 50 },
      ],
    }, 'MCP Worker')).toThrow('exactly one active production version');
  });

  it('parses the version ID emitted by a Wrangler version upload', () => {
    expect(parseUploadedVersionId(`Worker Version ID: ${UPLOADED.mcp}`)).toBe(UPLOADED.mcp);
    expect(() => parseUploadedVersionId('uploaded')).toThrow('did not report a Worker Version ID');
  });

  it('terminates a Wrangler command that exceeds its internal deadline', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn((signal: NodeJS.Signals) => {
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      }),
    });

    await expect(runWranglerCommand({
      args: ['versions', 'deploy', `${UPLOADED.mcp}@100`, '-y'],
      cwd: process.cwd(),
      spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
      timeoutMs: 1,
    })).rejects.toThrow('timed out after 1 ms');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uploads both versions before promoting docs and then MCP to 100%', async () => {
    const harness = createHarness();
    const result = await execute(harness);

    expect(result).toMatchObject({
      mcp_version_id: UPLOADED.mcp,
      docs_version_id: UPLOADED.docs,
      previous_mcp_version_id: PREVIOUS.mcp,
      previous_docs_version_id: PREVIOUS.docs,
      previous_version: '0.1.0',
    });
    const uploadMcp = harness.events.findIndex((event) => event.startsWith('mcp:versions upload'));
    const uploadDocs = harness.events.findIndex((event) => event.startsWith('docs:versions upload'));
    const deployDocs = harness.events.findIndex((event) => event.startsWith('docs:versions deploy'));
    const deployMcp = harness.events.findIndex((event) => event.startsWith('mcp:versions deploy'));
    expect(uploadMcp).toBeLessThan(uploadDocs);
    expect(uploadDocs).toBeLessThan(deployDocs);
    expect(deployDocs).toBeLessThan(deployMcp);
    expect(harness.events[deployDocs]).toContain(`${UPLOADED.docs}@100`);
    expect(harness.events[deployMcp]).toContain(`${UPLOADED.mcp}@100`);
    expect(harness.verifyProductionImpl).toHaveBeenCalledOnce();
    expect(harness.verifyRollbackImpl).not.toHaveBeenCalled();
    expect(harness.writeOutputs).toHaveBeenCalledOnce();
  });

  it('does not roll back when an upload fails before traffic changes', async () => {
    const harness = createHarness({ fail: (event) => event.startsWith('docs:versions upload') });
    await expect(execute(harness)).rejects.toThrow('Uploading Blume docs Worker failed');
    expect(harness.events.some((event) => event.includes(':rollback '))).toBe(false);
    expect(harness.monitorFactory).not.toHaveBeenCalled();
  });

  it('rolls back docs when its promotion reports a failure', async () => {
    const harness = createHarness({ fail: (event) => event.startsWith('docs:versions deploy') });
    await expect(execute(harness)).rejects.toThrow('failed and was rolled back');
    const rollbacks = harness.events.filter((event) => event.includes(':rollback '));
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]).toContain(`docs:rollback ${PREVIOUS.docs}`);
  });

  it('rolls back MCP first and docs second after a partial MCP cutover', async () => {
    const harness = createHarness({ fail: (event) => event.startsWith('mcp:versions deploy') });
    await expect(execute(harness)).rejects.toThrow('failed and was rolled back');
    const rollbacks = harness.events.filter((event) => event.includes(':rollback '));
    expect(rollbacks[0]).toContain(`mcp:rollback ${PREVIOUS.mcp}`);
    expect(rollbacks[1]).toContain(`docs:rollback ${PREVIOUS.docs}`);
    expect(harness.verifyRollbackImpl).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: '0.1.0',
    }));
  });

  it('rolls back both Workers when complete production verification fails', async () => {
    const harness = createHarness();
    harness.verifyProductionImpl.mockRejectedValueOnce(new Error('verification failed'));
    await expect(execute(harness)).rejects.toThrow('failed and was rolled back');
    expect(harness.events.filter((event) => event.includes(':rollback '))).toHaveLength(2);
    expect(harness.writeOutputs).not.toHaveBeenCalled();
  });

  it('treats a continuity-probe failure as a deployment failure', async () => {
    const harness = createHarness();
    harness.monitor.assertHealthy.mockImplementationOnce(() => {
      throw new Error('continuity failed');
    });
    await expect(execute(harness)).rejects.toThrow('failed and was rolled back');
    const rollbacks = harness.events.filter((event) => event.includes(':rollback '));
    expect(rollbacks).toEqual([expect.stringContaining(`docs:rollback ${PREVIOUS.docs}`)]);
  });

  it('aborts live verification and rolls back immediately when a probe fails', async () => {
    const harness = createHarness();
    const probeFailure = new Error('continuity failed during verification');
    harness.monitor.failed = Promise.resolve(probeFailure);
    let signal: AbortSignal | undefined;
    harness.verifyProductionImpl.mockImplementationOnce(async (options) => {
      signal = options.signal;
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
      });
    });

    await expect(execute(harness)).rejects.toThrow('failed and was rolled back');
    expect(signal?.aborted).toBe(true);
    expect(harness.events.filter((event) => event.includes(':rollback '))).toHaveLength(2);
  });

  it('attempts every rollback and reports when rollback itself fails', async () => {
    const harness = createHarness({
      fail: (event) => event.startsWith('mcp:rollback'),
    });
    harness.verifyProductionImpl.mockRejectedValueOnce(new Error('verification failed'));
    await expect(execute(harness)).rejects.toThrow('rollback needs attention');
    const rollbacks = harness.events.filter((event) => event.includes(':rollback '));
    expect(rollbacks).toHaveLength(2);
    expect(rollbacks[1]).toContain('docs:rollback');
  });

  it('rejects split production traffic before uploading either Worker', async () => {
    const harness = createHarness({ splitMcp: true });
    await expect(execute(harness)).rejects.toThrow('exactly one active production version');
    expect(harness.events.some((event) => event.includes(':versions upload'))).toBe(false);
  });

  it('restores both captured Workers after a later npm publication failure', async () => {
    const harness = createHarness();
    harness.active.mcp = UPLOADED.mcp;
    harness.active.docs = UPLOADED.docs;
    await restoreProduction({
      tag: 'v0.2.0',
      sha: SHA,
      mcpVersionId: PREVIOUS.mcp,
      docsVersionId: PREVIOUS.docs,
      expectedVersion: '0.1.0',
    }, {
      runWrangler: harness.runWrangler,
      verifyRollbackImpl: harness.verifyRollbackImpl,
      log: vi.fn(),
    });
    const rollbacks = harness.events.filter((event) => event.includes(':rollback '));
    expect(rollbacks).toEqual([
      expect.stringContaining(`mcp:rollback ${PREVIOUS.mcp}`),
      expect.stringContaining(`docs:rollback ${PREVIOUS.docs}`),
    ]);
    expect(harness.verifyRollbackImpl).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: '0.1.0',
    }));
  });
});

describe('continuous cutover probes', () => {
  it('records a failed response until the coordinator consumes it', async () => {
    let calls = 0;
    const monitor = createContinuityMonitor({
      intervalMs: 1,
      probe: async () => {
        calls += 1;
        if (calls > 1) throw new Error('HTTP 503');
      },
    });
    await monitor.ready;
    await vi.waitFor(() => expect(() => monitor.assertHealthy()).toThrow('HTTP 503'));
    await monitor.stop({ assertHealthy: false });
  });
});
