import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  parseLocalPackIntegrity,
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
  gitHead,
  integrity = INTEGRITY,
  latest = VERSION,
}: { gitHead?: string; integrity?: string; latest?: string } = {}) {
  return {
    name: PACKAGE_NAME,
    'dist-tags': { latest },
    versions: {
      [VERSION]: {
        name: PACKAGE_NAME,
        version: VERSION,
        ...(gitHead === undefined ? {} : { gitHead }),
        dist: { integrity, tarball: TARBALL },
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
  const runNpm = vi.fn(async ({ args }: { args: string[] }) => ({
    exitCode: 0,
    stderr: '',
    stdout: args[0] === 'pack'
      ? JSON.stringify({
          [PACKAGE_NAME]: {
            name: PACKAGE_NAME,
            version: VERSION,
            integrity: INTEGRITY,
          },
        })
      : '+ published',
  }));
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
    expect(testHarness.runNpm).toHaveBeenCalledTimes(2);
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
    expect(testHarness.runNpm).toHaveBeenCalledTimes(2);
    expect(testHarness.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('recovers when npm reports failure after the registry accepts the package', async () => {
    const testHarness = harness([
      response({}, 404),
      response(packument()),
    ]);
    testHarness.runNpm.mockImplementation(async ({ args }: { args: string[] }) => ({
      exitCode: args[0] === 'publish' ? 1 : 0,
      stderr: args[0] === 'publish' ? 'network error' : '',
      stdout: args[0] === 'pack'
        ? JSON.stringify([{ name: PACKAGE_NAME, version: VERSION, integrity: INTEGRITY }])
        : '',
    }));
    await expect(execute(testHarness)).resolves.toMatchObject({ package_version: VERSION });
  });

  it('rejects an immutable version published from another commit', async () => {
    const testHarness = harness([response(packument({ gitHead: 'b'.repeat(40) }))]);
    await expect(execute(testHarness)).rejects.toThrow('was published from');
    expect(testHarness.runNpm).toHaveBeenCalledTimes(2);
  });

  it('rejects an immutable version with different package content', async () => {
    const testHarness = harness([response(packument({ integrity: 'sha512-different' }))]);
    await expect(execute(testHarness)).rejects.toThrow('exact release package');
    expect(testHarness.runNpm).toHaveBeenCalledTimes(2);
  });

  it('fails when neither publishing nor bounded registry confirmation succeeds', async () => {
    const testHarness = harness(Array.from({ length: 20 }, () => response({}, 404)));
    testHarness.runNpm.mockImplementation(async ({ args }: { args: string[] }) => ({
      exitCode: args[0] === 'publish' ? 1 : 0,
      stderr: args[0] === 'publish' ? 'denied' : '',
      stdout: args[0] === 'pack'
        ? JSON.stringify([{ name: PACKAGE_NAME, version: VERSION, integrity: INTEGRITY }])
        : '',
    }));
    testHarness.sleep.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await expect(publishNpm(
      { sha: SHA, timeoutMs: 1, githubOutput: undefined },
      testHarness,
    )).rejects.toThrow('did not confirm');
    expect(testHarness.runNpm).toHaveBeenCalledTimes(3);
    expect(testHarness.writeOutputs).not.toHaveBeenCalled();
  });

  it('fails closed when the registry cannot be read', async () => {
    const testHarness = harness([response({}, 503)]);
    await expect(execute(testHarness)).rejects.toThrow('npm registry returned HTTP 503');
    expect(testHarness.runNpm).toHaveBeenCalledTimes(2);
  });
});

describe('published registry metadata', () => {
  it('requires integrity, a registry tarball, and the latest dist-tag', () => {
    expect(validatePublishedVersion(packument(), {
      packageName: PACKAGE_NAME,
      version: VERSION,
      sha: SHA,
      integrity: INTEGRITY,
    })).toEqual({ integrity: INTEGRITY, tarball: TARBALL });
    expect(validatePublishedVersion(packument({ latest: '0.1.0' }), {
      packageName: PACKAGE_NAME,
      version: VERSION,
      sha: SHA,
      integrity: INTEGRITY,
    })).toEqual({ pendingLatest: true });
  });

  it('accepts npm 10 arrays and npm 12 package-keyed pack output', () => {
    const expected = { packageName: PACKAGE_NAME, version: VERSION };
    const entry = { name: PACKAGE_NAME, version: VERSION, integrity: INTEGRITY };
    expect(parseLocalPackIntegrity(JSON.stringify([entry]), expected)).toBe(INTEGRITY);
    expect(parseLocalPackIntegrity(JSON.stringify({ [PACKAGE_NAME]: entry }), expected)).toBe(INTEGRITY);
  });
});
