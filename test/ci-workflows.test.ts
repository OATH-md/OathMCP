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
  });

  it('reserves release attestation and package proof for explicit release automation', () => {
    const workflow = loadWorkflow('.github/workflows/release-readiness.yml');

    expect(workflow.on.push?.tags).toEqual(['v*']);
    expect(Object.hasOwn(workflow.on, 'workflow_dispatch')).toBe(true);
    expect(runCommands(workflow)).toEqual(expect.arrayContaining([
      'npm run check',
      'npm run check:clinical-release',
      'npm --prefix docs-site run check',
      'npm pack --dry-run',
    ]));
  });
});
