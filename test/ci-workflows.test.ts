import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

interface Workflow {
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
    steps?: Array<{ run?: string }>;
  }>;
}

function loadWorkflow(path: string): Workflow {
  return YAML.parse(readFileSync(path, 'utf8')) as Workflow;
}

function runCommands(workflow: Workflow): string[] {
  return Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .flatMap((step) => step.run === undefined ? [] : [step.run]);
}

describe('GitHub workflow boundaries', () => {
  it('runs ordinary acceptance once for pull requests without requiring a release attestation', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml');

    expect(workflow.on.push?.branches).toEqual(['main']);
    expect(Object.hasOwn(workflow.on, 'pull_request')).toBe(true);
    expect(runCommands(workflow)).toContain('npm run check');
    expect(runCommands(workflow)).not.toContain('npm run check:clinical-release');
    expect(runCommands(workflow.jobs.docs === undefined
      ? { ...workflow, jobs: {} }
      : { ...workflow, jobs: { docs: workflow.jobs.docs } })).toContain('npm run check');
  });

  it('validates, deploys both Workers, verifies production, and publishes only from version tags', () => {
    const workflow = loadWorkflow('.github/workflows/release-readiness.yml');
    const commands = runCommands(workflow);

    expect(workflow.on.push?.tags).toEqual(['v*']);
    expect(Object.hasOwn(workflow.on, 'workflow_dispatch')).toBe(true);
    expect(commands).toContain('npm run check:release');
    expect(commands).toContain('npm run verify:production');
    expect(commands.some((command) => command.includes('npm publish --access public'))).toBe(true);
    expect(commands.some((command) => command.includes('npm run check:release-metadata -- --tag'))).toBe(true);
    expect(commands.some((command) => command.includes('git merge-base --is-ancestor'))).toBe(true);
    expect(commands.filter((command) => command.includes('npx wrangler deploy'))).toHaveLength(2);
    expect(commands.some((command) => command.includes('gh release create'))).toBe(true);

    expect(workflow.jobs['deploy-production']?.if).toContain("refs/tags/v");
    expect(workflow.jobs['verify-production']?.needs).toBe('deploy-production');
    expect(workflow.jobs['publish-npm']?.if).toContain('NPM_PUBLISH_ENABLED');
    expect(workflow.jobs['deploy-production']?.environment).toMatchObject({ name: 'production' });
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
