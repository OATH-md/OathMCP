import type { Reporter } from 'vitest/reporters';

function printError(error: unknown): void {
  if (error && typeof error === 'object') {
    if ('stack' in error && typeof error.stack === 'string') {
      console.error(error.stack);
      return;
    }
    if ('message' in error && typeof error.message === 'string') {
      console.error(error.message);
      return;
    }
  }
  console.error(String(error));
}

export const workersCiReporter = {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const tests = testModules.flatMap((testModule) => [
      ...testModule.children.allTests(),
    ]);
    const passedTests = tests.filter(
      (testCase) => testCase.result().state === 'passed',
    );
    const failedModules = testModules.filter((testModule) => !testModule.ok());

    console.log(
      `Workers CI: ${testModules.length - failedModules.length}/${testModules.length} files passed; ${passedTests.length}/${tests.length} tests passed; unhandledErrors=${unhandledErrors.length}; status=${reason}`,
    );

    for (const testModule of failedModules) {
      console.error(`FAIL ${testModule.moduleId}`);
      testModule.errors().forEach(printError);
      for (const testCase of testModule.children.allTests('failed')) {
        console.error(`  ${testCase.fullName}`);
        testCase.result().errors?.forEach(printError);
      }
    }
    // Vitest can report all modules as passed while separately setting a
    // failing exit code for worker/RPC errors. Always print that channel.
    unhandledErrors.forEach(printError);
  },
} satisfies Reporter;
