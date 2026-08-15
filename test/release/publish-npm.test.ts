import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  parsePublishArgs,
  publishNpm,
  validatePublishedVersion,
} from '../../scripts/release/publish-npm.mjs';

const PACKAGE_NAME = '@oath-md/oath-mcp';
const VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const SHA = 'a'.repeat(40);
const TARBALL = `https://registry.npmjs.org/@oath-md/oath-mcp/-/oath-mcp-${VERSION}.tgz`;
const INTEGRITY = `sha512-${Buffer.from('integrity').toString('base64')}`;

function packument({
  gitHead = SHA,
  latest = VERSION,
}: { gitHead?: string; latest?: string } = {}) {
  return {
    name: PACKAGE_NAME,
    'dist-tags': { latest },
    versions: {
      [VERSION]: {
        name: PACKAGE_NAME,
        version: VERSION,
        gitHead,
        dist: { integrity: INTEGRITY, tarball: TARBALL },
      },
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(responses: Response[]) {
  const fetchImpl = vi.fn(async () => responses.shift() ?? response(packument()));
  const runNpm = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '+ published' }));
  const writeOutputs = vi.fn(async () => undefined);
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    runNpm,
    sleep: vi.fn(async () => undefined),
    writeOutputs,
    log: vi.fn(),
  };
}

async function execute(testHarness: ReturnType<typeof harness>) {
  return publishNpm(
    { sha: SHA, timeoutMs: 100, githubOutput: '/tmp/github-output' },
    testHarness,
  );
}

describe('npm release publication', () => {
  it('requires an exact release commit', () => {
    expect(parsePublishArgs(['--sha', SHA])).toEqual({ sha: SHA });
    expect(() => parsePublishArgs(['--sha', 'abc'])).toThrow('full 40-character');
  });

  it('accepts an existing version from the exact release commit', async () => {
    const testHarness = harness([response(packument())]);
    await expect(execute(testHarness)).resolves.toMatchObject({
      package_name: PACKAGE_NAME,
      package_version: VERSION,
      package_integrity: INTEGRITY,
      package_tarball: TARBALL,
    });
    expect(testHarness.runNpm).not.toHaveBeenCalled();
    expect(testHarness.writeOutputs).toHaveBeenCalledOnce();
  });

  it('publishes one absent version and waits for registry confirmation', async () => {
    const testHarness = harness([
      response({ name: PACKAGE_NAME, 'dist-tags': {}, versions: {} }),
      response(packument()),
    ]);
    await expect(execute(testHarness)).resolves.toMatchObject({ package_version: VERSION });
    expect(testHarness.runNpm).toHaveBeenCalledWith(expect.objectContaining({
      args: ['publish', '--access', 'public'],
    }));
  });

  it('waits until latest points to the release version', async () => {
    const testHarness = harness([
      response(packument({ latest: '0.1.0' })),
      response(packument()),
    ]);
    await expect(execute(testHarness)).resolves.toMatchObject({ package_version: VERSION });
    expect(testHarness.runNpm).not.toHaveBeenCalled();
    expect(testHarness.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('recovers when npm reports failure after the registry accepts the package', async () => {
    const testHarness = harness([
      response({}, 404),
      response(packument()),
    ]);
    testHarness.runNpm.mockResolvedValueOnce({ exitCode: 1, stderr: 'network error', stdout: '' });
    await expect(execute(testHarness)).resolves.toMatchObject({ package_version: VERSION });
  });

  it('rejects an immutable version published from another commit', async () => {
    const testHarness = harness([response(packument({ gitHead: 'b'.repeat(40) }))]);
    await expect(execute(testHarness)).rejects.toThrow('was published from');
    expect(testHarness.runNpm).not.toHaveBeenCalled();
  });

  it('fails when neither publishing nor bounded registry confirmation succeeds', async () => {
    const testHarness = harness(Array.from({ length: 20 }, () => response({}, 404)));
    testHarness.runNpm.mockResolvedValueOnce({ exitCode: 1, stderr: 'denied', stdout: '' });
    testHarness.sleep.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await expect(publishNpm(
      { sha: SHA, timeoutMs: 1, githubOutput: undefined },
      testHarness,
    )).rejects.toThrow('did not confirm');
    expect(testHarness.runNpm).toHaveBeenCalledOnce();
    expect(testHarness.writeOutputs).not.toHaveBeenCalled();
  });

  it('fails closed when the registry cannot be read', async () => {
    const testHarness = harness([response({}, 503)]);
    await expect(execute(testHarness)).rejects.toThrow('npm registry returned HTTP 503');
    expect(testHarness.runNpm).not.toHaveBeenCalled();
  });
});

describe('published registry metadata', () => {
  it('requires integrity, a registry tarball, and the latest dist-tag', () => {
    expect(validatePublishedVersion(packument(), {
      packageName: PACKAGE_NAME,
      version: VERSION,
      sha: SHA,
    })).toEqual({ integrity: INTEGRITY, tarball: TARBALL });
    expect(validatePublishedVersion(packument({ latest: '0.1.0' }), {
      packageName: PACKAGE_NAME,
      version: VERSION,
      sha: SHA,
    })).toEqual({ pendingLatest: true });
  });
});
