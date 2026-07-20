import { afterEach, describe, expect, it, vi } from 'vitest';
import { workersCiReporter } from './support/workers-ci-reporter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Workers CI reporter', () => {
  it('prints unhandled worker errors even when every test module passed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const passingTest = {
      fullName: 'passes normally',
      result: () => ({ state: 'passed' }),
    };
    const passingModule = {
      moduleId: 'passing.test.ts',
      ok: () => true,
      errors: () => [],
      children: {
        allTests: (state?: string) => state === 'failed' ? [] : [passingTest],
      },
    };
    const workerError = new Error('[vitest-worker]: Timeout calling "onTaskUpdate"');

    await workersCiReporter.onTestRunEnd(
      [passingModule] as never,
      [workerError] as never,
      'passed',
    );

    expect(log).toHaveBeenCalledWith(expect.stringContaining('unhandledErrors=1'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Timeout calling "onTaskUpdate"'));
  });
});
