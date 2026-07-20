import { defineConfig } from 'vitest/config';
import { workersCiReporter } from './test/support/workers-ci-reporter.js';

const isCi = process.env.CI === 'true';
const isWorkersCi = process.env.WORKERS_CI === '1';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // MCP catalog construction is CPU-heavy. GitHub's two-core hosted runner
    // slows sharply when catalog and transport suites compete. Run files
    // serially in CI to avoid starving Vitest's worker channel; retain bounded
    // two-file parallelism on development hosts. Assertions are unchanged.
    fileParallelism: !isCi,
    maxWorkers: isCi ? 1 : 2,
    // Workers Builds streams test output through a remote log collector. Its
    // reporter does no per-test work, so that path cannot starve Vitest's
    // worker RPC. Core Vitest still owns the process exit status; failures are
    // printed once, with their stacks, when the run ends.
    ...(isWorkersCi ? { reporters: [workersCiReporter] } : {}),
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
