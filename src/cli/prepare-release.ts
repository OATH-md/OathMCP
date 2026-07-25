import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import {
  ReleaseEvidenceAttestationSchema,
  deriveReleaseRequirements,
  loadAuthorityRegistry,
  loadValidationCatalog,
  loadValidationDossiers,
  releaseAttestationInventory,
  validateReleaseEvidenceAttestation,
  validateReleaseReviewCurrentness,
  validateReleaseSourceCurrentness,
  validateReleaseSourceVersions,
  type ReleaseEvidenceAttestation,
} from '../validation/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

interface PrepareReleaseArgs {
  version: string;
  reviewer: string;
  reviewerTimeZone: string;
  checkedAt: string;
  networkCheckedAt: string;
  summary: string;
  confirmCurrentness: boolean;
  dryRun: boolean;
}

function usage(): void {
  process.stderr.write(
    'Usage: npm run release:prepare -- --version X.Y.Z --reviewer NAME ' +
    '--reviewer-time-zone AREA/CITY --checked-at YYYY-MM-DD ' +
    '--network-checked-at YYYY-MM-DD --summary TEXT --confirm-currentness [--dry-run]\n',
  );
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

export function parsePrepareReleaseArgs(argv: string[]): PrepareReleaseArgs {
  const values: Partial<PrepareReleaseArgs> = {
    confirmCurrentness: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--version') {
      values.version = requiredValue(argv, index, token);
      index += 1;
    } else if (token === '--reviewer') {
      values.reviewer = requiredValue(argv, index, token);
      index += 1;
    } else if (token === '--reviewer-time-zone') {
      values.reviewerTimeZone = requiredValue(argv, index, token);
      index += 1;
    } else if (token === '--checked-at') {
      values.checkedAt = requiredValue(argv, index, token);
      index += 1;
    } else if (token === '--network-checked-at') {
      values.networkCheckedAt = requiredValue(argv, index, token);
      index += 1;
    } else if (token === '--summary') {
      values.summary = requiredValue(argv, index, token);
      index += 1;
    } else if (token === '--confirm-currentness') {
      values.confirmCurrentness = true;
    } else if (token === '--dry-run') {
      values.dryRun = true;
    } else {
      throw new Error(`unknown option '${token}'`);
    }
  }
  for (const [field, option] of [
    ['version', '--version'],
    ['reviewer', '--reviewer'],
    ['reviewerTimeZone', '--reviewer-time-zone'],
    ['checkedAt', '--checked-at'],
    ['networkCheckedAt', '--network-checked-at'],
    ['summary', '--summary'],
  ] as const) {
    if (values[field] === undefined) throw new Error(`${option} is required`);
  }
  if (!values.confirmCurrentness) {
    throw new Error('--confirm-currentness is required after the release source/currentness review is complete');
  }
  return values as PrepareReleaseArgs;
}

function versionTuple(version: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) throw new Error(`release version must be an exact X.Y.Z version, received '${version}'`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = versionTuple(left);
  const rightParts = versionTuple(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

interface PackageJson {
  version?: string;
  packages?: Record<string, { version?: string }>;
  [key: string]: unknown;
}

export function updatePackageVersion(text: string, version: string, lockfile = false): string {
  const parsed = JSON.parse(text) as PackageJson;
  parsed.version = version;
  if (lockfile) {
    const rootPackage = parsed.packages?.[''];
    if (rootPackage === undefined) throw new Error('package lock is missing packages[""]');
    rootPackage.version = version;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function insertChangelogEntry(
  changelog: string,
  version: string,
  date: string,
  summary: string,
): string {
  if (new RegExp(`^## ${version.replaceAll('.', '\\.')}\\b`, 'mu').test(changelog)) {
    throw new Error(`CHANGELOG.md already contains ${version}`);
  }
  const release = `## ${version} — ${date}\n\n- ${summary.trim()}\n`;
  const unreleased = /^## Unreleased[^\S\r\n]*\r?\n(?:\r?\n)*/mu.exec(changelog);
  if (unreleased !== null) {
    const before = changelog.slice(0, unreleased.index);
    const existingNotes = changelog.slice(unreleased.index + unreleased[0].length)
      .replace(/^(?:\r?\n)+/u, '');
    return `${before}## Unreleased\n\n${release}${existingNotes}`;
  }
  const entry = `${release}\n`;
  const firstRelease = changelog.indexOf('\n## ');
  if (firstRelease === -1) return `${changelog.trimEnd()}\n\n${entry}`;
  return `${changelog.slice(0, firstRelease + 1)}${entry}${changelog.slice(firstRelease + 1)}`;
}

function readJsonVersion(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error(`${path} is missing a string version`);
  return parsed.version;
}

function collectAttestation(args: PrepareReleaseArgs): ReleaseEvidenceAttestation {
  const requirements = deriveReleaseRequirements(
    loadValidationCatalog(),
    loadValidationDossiers(),
    loadAuthorityRegistry(),
  );
  const attestation = ReleaseEvidenceAttestationSchema.parse({
    schemaVersion: '1.0',
    packageVersion: args.version,
    checkedAt: args.checkedAt,
    networkCheckedAt: args.networkCheckedAt,
    reviewer: args.reviewer,
    reviewerTimeZone: args.reviewerTimeZone,
    currentnessConfirmed: args.confirmCurrentness,
    unresolvedChanges: [],
    ...releaseAttestationInventory(requirements),
  });
  const errors = [
    ...validateReleaseEvidenceAttestation(attestation, args.version).errors,
    ...validateReleaseSourceVersions(attestation, requirements.requiredByCalculator),
    ...validateReleaseSourceCurrentness(attestation, requirements.checkedAtByCalculator),
    ...validateReleaseReviewCurrentness(attestation, requirements.reviewedAtByCalculator),
  ];
  if (errors.length > 0) {
    throw new Error([
      'release attestation is not valid:',
      ...errors.map((entry) => `- ${entry.code}: ${entry.message}`),
      `Latest recorded source check: ${requirements.latestSourceCheckedAt}`,
      `Latest recorded claim review: ${requirements.latestClaimReviewedAt}`,
    ].join('\n'));
  }
  return attestation;
}

export async function prepareRelease(argv: string[]): Promise<number> {
  let args: PrepareReleaseArgs;
  try {
    args = parsePrepareReleaseArgs(argv);
  } catch (error) {
    usage();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  try {
    const packagePath = join(ROOT, 'package.json');
    const packageLockPath = join(ROOT, 'package-lock.json');
    const docsPackagePath = join(ROOT, 'docs-site', 'package.json');
    const docsPackageLockPath = join(ROOT, 'docs-site', 'package-lock.json');
    const changelogPath = join(ROOT, 'CHANGELOG.md');
    const currentVersion = readJsonVersion(packagePath);
    if (compareReleaseVersions(args.version, currentVersion) <= 0) {
      throw new Error(`release version ${args.version} must be newer than package version ${currentVersion}`);
    }
    const attestationPath = join(ROOT, 'validation', 'releases', `${args.version}.yaml`);
    if (existsSync(attestationPath)) throw new Error(`${attestationPath} already exists`);

    const attestation = collectAttestation(args);
    const updates = new Map<string, string>([
      [packagePath, updatePackageVersion(readFileSync(packagePath, 'utf8'), args.version)],
      [packageLockPath, updatePackageVersion(readFileSync(packageLockPath, 'utf8'), args.version, true)],
      [docsPackagePath, updatePackageVersion(readFileSync(docsPackagePath, 'utf8'), args.version)],
      [docsPackageLockPath, updatePackageVersion(readFileSync(docsPackageLockPath, 'utf8'), args.version, true)],
      [
        changelogPath,
        insertChangelogEntry(readFileSync(changelogPath, 'utf8'), args.version, args.checkedAt, args.summary),
      ],
      [attestationPath, stringifyYaml(attestation, { lineWidth: 0 })],
    ]);

    if (args.dryRun) {
      process.stdout.write(
        `Release ${args.version} is ready to scaffold for ${attestation.calculatorIds.length} calculators ` +
        `and ${Object.keys(attestation.sourceVersions).length} source versions.\n`,
      );
      for (const path of updates.keys()) process.stdout.write(`Would update ${path}\n`);
      return 0;
    }

    for (const [path, contents] of updates) writeFileSync(path, contents);
    process.stdout.write(
      `Prepared release ${args.version}: ${attestation.calculatorIds.length} calculators, ` +
      `${Object.keys(attestation.sourceVersions).length} source versions.\n` +
      'Next: review the diff, run npm --prefix docs-site run generate, then npm run check:release.\n',
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
