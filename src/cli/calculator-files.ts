import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import * as z from 'zod/v4';
import {
  CalculatorIdSchema,
  DraftCalculatorSchema,
  DraftMetadataSchema,
  type DraftCalculator,
  type ProductionCandidate,
} from '../validation/draft-schema.js';
import { GENERATED_ARTIFACT_PATHS } from './bundle-specs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DRAFTS_DIR = join(ROOT, 'drafts/calculators');
export const TEMPLATES_DIR = join(ROOT, 'templates/calculator');

function readRecord(path: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(parseYaml(readFileSync(path, 'utf8')) as unknown);
}

export function loadDraftCalculator(id: string): DraftCalculator {
  CalculatorIdSchema.parse(id);
  const directory = join(DRAFTS_DIR, id);
  const spec = readRecord(join(directory, 'spec.yaml'));
  const validation = readRecord(join(directory, 'validation.yaml'));
  const specDraft = DraftMetadataSchema.parse(spec.draft);
  const validationDraft = DraftMetadataSchema.parse(validation.draft);
  if (specDraft.archetype !== validationDraft.archetype) {
    throw new Error('spec and validation draft archetypes disagree');
  }
  return DraftCalculatorSchema.parse({
    id,
    archetype: specDraft.archetype,
    spec,
    validation,
    computeSource: readFileSync(join(directory, 'compute.ts'), 'utf8'),
  });
}

function liveComputeSource(candidate: ProductionCandidate): string {
  return [
    "import { registerCompute } from '../engine/registry.js';",
    candidate.computeSource.trim(),
    '',
    `registerCompute('${candidate.id}', compute);`,
    '',
  ].join('\n');
}

function prospectiveCatalog(candidate: ProductionCandidate, root: string): string {
  const path = join(root, 'validation/catalog.yaml');
  const catalog = parseYaml(readFileSync(path, 'utf8')) as {
    groups: Array<{ id: string; calculatorIds: string[] }>;
  };
  const group = catalog.groups.find((entry) => entry.id === candidate.dossier.reviewGroup);
  if (group === undefined) throw new Error(`unknown review group '${candidate.dossier.reviewGroup}'`);
  if (!group.calculatorIds.includes(candidate.id)) group.calculatorIds.push(candidate.id);
  group.calculatorIds.sort();
  return stringifyYaml(catalog, { lineWidth: 120 });
}

export interface CandidatePreflight {
  temporaryRoot: string;
  files: ReadonlyMap<string, string>;
}

function run(root: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    throw new Error([`preflight failed: ${command} ${args.join(' ')}`, result.stdout, result.stderr].filter(Boolean).join('\n'));
  }
}

export function runProspectiveChecks(
  root: string,
  calculatorId: string,
  invoke: (root: string, command: string, args: string[]) => void = run,
): void {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Generation must lead: it widens the exact calculator ID/input/output
  // contracts and registration index before any prospective command imports
  // the candidate runtime.
  invoke(root, npm, ['run', 'gen:specs']);
  invoke(root, npm, ['run', 'lint:specs']);
  invoke(root, npm, ['run', 'typecheck']);
  invoke(root, npm, ['run', 'build']);
  invoke(root, npm, ['run', 'validate:clinical', '--', '--calculator', calculatorId, '--require-source-verified', '--require-scenario-verified']);
  invoke(root, npm, ['run', 'test']);
}

/** Build and validate a candidate in an isolated copy before any live write. */
export function preflightCandidate(candidate: ProductionCandidate): CandidatePreflight {
  const temporaryRoot = join(tmpdir(), `oath-mcp-candidate-${candidate.id}-${process.pid}-${Date.now()}`);
  mkdirSync(temporaryRoot, { recursive: true });
  try {
    cpSync(ROOT, temporaryRoot, {
      recursive: true,
      filter: (source) => ![
        '.git', '.agents', '.claude', '.codex', '.cursor', '.orchestra',
        'node_modules', 'dist', 'drafts',
      ].includes(basename(source)),
    });
    symlinkSync(join(ROOT, 'node_modules'), join(temporaryRoot, 'node_modules'), 'dir');
    writeFileSync(join(temporaryRoot, `specs/${candidate.id}.yaml`), stringifyYaml(candidate.spec, { lineWidth: 120 }));
    writeFileSync(join(temporaryRoot, `validation/calculators/${candidate.id}.yaml`), stringifyYaml(candidate.dossier, { lineWidth: 120 }));
    writeFileSync(join(temporaryRoot, `src/compute/${candidate.id}.ts`), liveComputeSource(candidate));
    writeFileSync(join(temporaryRoot, 'validation/catalog.yaml'), prospectiveCatalog(candidate, temporaryRoot));

    runProspectiveChecks(temporaryRoot, candidate.id);

    const candidatePaths = [
      `specs/${candidate.id}.yaml`,
      `validation/calculators/${candidate.id}.yaml`,
      `src/compute/${candidate.id}.ts`,
      'validation/catalog.yaml',
    ];
    const files = new Map(
      [...candidatePaths, ...Object.values(GENERATED_ARTIFACT_PATHS)]
        .map((path) => [path, readFileSync(join(temporaryRoot, path), 'utf8')] as const),
    );
    return { temporaryRoot, files };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupPreflight(preflight: CandidatePreflight): void {
  rmSync(preflight.temporaryRoot, { recursive: true, force: true });
}

interface StagedInstall {
  target: string;
  staged: string;
  backup: string;
  existed: boolean;
}

export class PromotionRollbackError extends AggregateError {
  constructor(errors: Iterable<unknown>, readonly preservedBackupPaths: readonly string[]) {
    super(errors, 'promotion installation failed and rollback was incomplete');
  }
}

/** Install all prospective files with rollback if any replacement fails. */
export function installPreflight(
  preflight: CandidatePreflight,
  replaceFile: typeof renameSync = renameSync,
  restoreFile: typeof renameSync = renameSync,
): void {
  const token = `oath-promote-${process.pid}-${Date.now()}`;
  const staged: StagedInstall[] = [];
  let rollbackIncomplete = false;
  try {
    for (const [relativePath, content] of preflight.files) {
      const target = join(ROOT, relativePath);
      const directory = dirname(target);
      const name = basename(target);
      const stagedPath = join(directory, `.${name}.${token}.staged`);
      const backupPath = join(directory, `.${name}.${token}.backup`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(stagedPath, content);
      const existed = existsSync(target);
      if (existed) copyFileSync(target, backupPath);
      staged.push({ target, staged: stagedPath, backup: backupPath, existed });
    }
    for (const entry of staged) replaceFile(entry.staged, entry.target);
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const entry of [...staged].reverse()) {
      try {
        if (entry.existed && existsSync(entry.backup)) restoreFile(entry.backup, entry.target);
        else if (!entry.existed) rmSync(entry.target, { force: true });
      } catch (rollbackError) {
        rollbackFailures.push(`${entry.target}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      rollbackIncomplete = true;
      throw new PromotionRollbackError(
        [error, ...rollbackFailures.map((message) => new Error(message))],
        staged.map((entry) => entry.backup).filter(existsSync),
      );
    }
    throw error;
  } finally {
    for (const entry of staged) {
      rmSync(entry.staged, { force: true });
      if (!rollbackIncomplete) rmSync(entry.backup, { force: true });
    }
  }
}

export function liveCandidateExists(id: string): boolean {
  return [join(ROOT, `specs/${id}.yaml`), join(ROOT, `src/compute/${id}.ts`), join(ROOT, `validation/calculators/${id}.yaml`)]
    .some(existsSync);
}
