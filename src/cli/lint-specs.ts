import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  assertComputeCoverage,
  assertNamingConventions,
  assertSharedInputCompatibility,
} from '../engine/lint-specs.js';
import { loadSpecs } from '../engine/load-specs.js';
import { getRegisteredComputeIds } from '../engine/registry.js';
import { requiredCaseTags } from '../validation/coverage.js';
import { independentReferenceCaseCount } from '../validation/integrity.js';
import { loadValidationDossiers } from '../validation/load-validation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const COMPUTE_DIR = join(ROOT, 'src/compute');
const LEGACY_FIXTURE_KEY = ['golden', 'Tests'].join('');
const LEGACY_SCAN_ROOTS = ['specs', 'src', 'test', 'templates'] as const;

function assertNoLegacyRuntimeFixtures(): void {
  const matches: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && readFileSync(child, 'utf8').includes(LEGACY_FIXTURE_KEY)) {
        matches.push(child.slice(ROOT.length + 1));
      }
    }
  };
  LEGACY_SCAN_ROOTS.forEach((root) => visit(join(ROOT, root)));
  if (matches.length > 0) {
    throw new Error(`Legacy runtime fixture key found in: ${matches.sort().join(', ')}`);
  }
}

function assertAuthoritativeCaseCoverage(specs: ReturnType<typeof loadSpecs>): void {
  const dossiers = loadValidationDossiers();
  for (const [id, spec] of specs) {
    const dossier = dossiers.get(id);
    if (dossier === undefined) throw new Error(`Missing validation dossier for ${id}`);
    if (independentReferenceCaseCount(dossier) < 3) {
      throw new Error(`${id}: requires at least three independent source-derived reference cases`);
    }
    const linkedReferences = dossier.cases.filter((testCase) =>
      testCase.kind === 'reference' && testCase.claimIds.length > 0 &&
      testCase.sourceIds.length > 0 && testCase.witnesses.length > 0);
    if (linkedReferences.length < 3) {
      throw new Error(`${id}: reference cases must link claims, sources, and behavior witnesses`);
    }
    for (const tag of requiredCaseTags(spec)) {
      if (!dossier.cases.some((testCase) => testCase.tags.includes(tag))) {
        throw new Error(`${id}: missing feature-derived case tag ${tag}`);
      }
    }
  }
}

/** Extract literal registerCompute ids without importing the source modules. */
export function registeredComputeIdsFromSources(
  sources: Readonly<Record<string, string>>,
): string[] {
  const ids: string[] = [];
  for (const text of Object.values(sources)) {
    for (const match of text.matchAll(/registerCompute\(\s*['"]([^'"]+)['"]/g)) {
      ids.push(match[1]);
    }
  }
  return ids.sort();
}

function registeredComputeSourceIds(): string[] | null {
  if (!existsSync(COMPUTE_DIR)) return null;
  const sources = Object.fromEntries(
    readdirSync(COMPUTE_DIR)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => [file, readFileSync(join(COMPUTE_DIR, file), 'utf8')]),
  );
  return registeredComputeIdsFromSources(sources);
}

/** Validate the complete declarative and executable calculator catalog. */
export async function lintSpecs(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    throw new Error('lint-specs does not accept arguments');
  }
  await import('../compute/index.generated.js');
  const specs = loadSpecs();
  const today = new Date().toISOString().slice(0, 10);
  const overdue = [...specs.values()].filter(
    (spec) => spec.reviewAfter !== undefined && spec.reviewAfter <= today,
  );
  if (overdue.length > 0) {
    throw new Error(
      `Clinical reference review overdue: ${overdue
        .map((spec) => `${spec.id} (${spec.reviewAfter})`)
        .join(', ')}`,
    );
  }
  const sourceIds = registeredComputeSourceIds();
  if (sourceIds !== null) {
    assertComputeCoverage(specs.keys(), sourceIds);
  }
  assertComputeCoverage(specs.keys(), getRegisteredComputeIds());
  assertSharedInputCompatibility(specs.values());
  assertNamingConventions(specs.values());
  assertNoLegacyRuntimeFixtures();
  assertAuthoritativeCaseCoverage(specs);
  process.stdout.write(`Validated ${specs.size} calculator specs.\n`);
  return 0;
}
