import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

interface Workflow {
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: boolean;
  };
  on: {
    push?: {
      branches?: string[];
      tags?: string[];
    };
    pull_request?: unknown;
    workflow_dispatch?: unknown;
  };
  jobs: Record<string, {
    if?: string;
    needs?: string | string[];
    environment?: string | { name?: string; url?: string };
    strategy?: { matrix?: { 'node-version'?: number[] } };
    'timeout-minutes'?: number;
    steps?: Array<{ run?: string }>;
  }>;
}

function loadWorkflow(path: string): Workflow {
  return YAML.parse(readFileSync(path, 'utf8')) as Workflow;
}

function runCommands(workflow: Workflow, jobName?: string): string[] {
  const job = jobName === undefined ? undefined : workflow.jobs[jobName];
  const jobs = jobName === undefined
    ? Object.values(workflow.jobs)
    : job === undefined ? [] : [job];
  return jobs
    .flatMap((entry) => entry.steps ?? [])
    .flatMap((step) => step.run === undefined ? [] : [step.run]);
}

describe('GitHub workflow boundaries', () => {
  it('runs ordinary acceptance once for pull requests without requiring a release attestation', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');

    expect(workflow.on.push?.branches).toEqual(['main']);
    expect(Object.hasOwn(workflow.on, 'pull_request')).toBe(true);
    expect(runCommands(workflow, 'check')).toEqual(expect.arrayContaining([
      'npm run check',
      'npm run check:worker',
    ]));
    expect(runCommands(workflow)).not.toContain('npm run check:clinical-release');
    expect(runCommands(workflow, 'docs')).toContain('npm run check');
    expect(workflow.jobs['package-consumer']?.strategy?.matrix?.['node-version']).toEqual([22, 24]);
    expect(runCommands(workflow, 'package-consumer')).toContain('npm run check:package-consumer');
  });

  it('validates, deploys both Workers, verifies production, and publishes only from version tags', () => {
    const workflow = loadWorkflow('.github/workflows/release-readiness.yml');
    const commands = runCommands(workflow);
    const validateReleaseCommands = runCommands(workflow, 'validate-release');
    const coordinator = readFileSync('scripts/release/deploy-production.mjs', 'utf8');

    expect(workflow.on.push?.tags).toEqual(['v*']);
    expect(Object.hasOwn(workflow.on, 'workflow_dispatch')).toBe(true);
    expect(workflow.concurrency).toEqual({
      group: 'oathmcp-production-release',
      'cancel-in-progress': false,
    });
    expect(validateReleaseCommands).toEqual(expect.arrayContaining([
      'npm run check:release',
      'npm run check:worker',
    ]));
    expect(commands.some((command) => command.includes('npm run deploy:production'))).toBe(true);
    expect(commands.some((command) => command.includes('npm run publish:npm'))).toBe(true);
    expect(commands.some((command) => command.includes('npm run check:release-metadata -- --tag'))).toBe(true);
    expect(commands.some((command) => command.includes('git merge-base --is-ancestor'))).toBe(true);
    expect(commands.some((command) => command.includes('npx wrangler deploy'))).toBe(false);
    expect(coordinator.match(/'versions', 'upload'/gu)).toHaveLength(1);
    expect(coordinator.match(/'versions', 'deploy'/gu)).toHaveLength(1);
    expect(coordinator).toContain("`${versionId}@100`");
    expect(coordinator).toContain("for (const key of ['mcp', 'docs'])");
    expect(coordinator).toContain('const verification = verifyProductionImpl({');
    expect(commands.some((command) => command.includes('gh release create'))).toBe(true);

    expect(workflow.jobs['deploy-production']?.if).toContain("refs/tags/v");
    expect(workflow.jobs['deploy-production']?.needs).toBe('validate-release');
    expect(workflow.jobs['verify-production']).toBeUndefined();
    expect(workflow.jobs['publish-npm']?.needs).toBe('deploy-production');
    expect(workflow.jobs['publish-npm']?.if).not.toContain('NPM_PUBLISH_ENABLED');
    expect(workflow.jobs['publish-npm']?.environment).toBe('npm-publish');
    expect(workflow.jobs['rollback-after-npm-failure']?.needs).toEqual([
      'deploy-production',
      'publish-npm',
    ]);
    expect(runCommands(workflow, 'rollback-after-npm-failure'))
      .toEqual(expect.arrayContaining([expect.stringContaining('npm run rollback:production')]));
    expect(runCommands(workflow, 'publish-github-release'))
      .toEqual(expect.arrayContaining([expect.stringContaining('PACKAGE_TARBALL')]));
    expect(workflow.jobs['deploy-production']?.environment).toMatchObject({ name: 'production' });
    expect(workflow.jobs['deploy-production']?.['timeout-minutes']).toBeGreaterThanOrEqual(45);
  });

  it('resolves the release attestation from the package version and includes Blume in the release gate', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['check:clinical-release']).toContain('--release-attestation auto');
    expect(packageJson.scripts['check:release']).toContain('npm --prefix docs-site run check');
    expect(packageJson.scripts['check:deploy']).toContain('npm run check:release');
  });
});
