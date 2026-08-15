import { describe, expect, it, vi } from 'vitest';

import {
  assertBelowFreeLimit,
  checkWorkerBundle,
  parseGzipSize,
} from '../scripts/check-worker-bundle.mjs';

describe('Worker bundle-size gate', () => {
  it.each([
    ['Total Upload: 857.34 KiB / gzip: 220.78 KiB', 220.78 * 1024],
    ['Total Upload: 4.00 MiB / gzip: 2.50 MiB', 2.5 * 1024 ** 2],
  ])('normalizes Wrangler output: %s', (output, bytes) => {
    expect(parseGzipSize(output).bytes).toBe(bytes);
  });

  it('fails when Wrangler omits the gzip total', () => {
    expect(() => parseGzipSize('Total Upload: 857.34 KiB')).toThrow(
      'Wrangler output did not report a gzip bundle size',
    );
  });

  it('rejects the exact Cloudflare Free 3 MiB limit', () => {
    expect(() => assertBelowFreeLimit(parseGzipSize(
      'Total Upload: 4.00 MiB / gzip: 3.00 MiB',
    ))).toThrow('must remain below 3 MiB');
  });

  it('preserves a failed Wrangler exit code without reporting success', async () => {
    const log = vi.fn();
    const exitCode = await checkWorkerBundle({
      log,
      runWrangler: async () => ({ exitCode: 17, stderr: 'failed', stdout: '' }),
    });

    expect(exitCode).toBe(17);
    expect(log).not.toHaveBeenCalled();
  });
});
