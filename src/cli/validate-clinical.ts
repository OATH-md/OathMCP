import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  ReleaseEvidenceAttestationSchema,
  validateClinicalCatalog,
  type ReleaseEvidenceAttestation,
} from '../validation/index.js';

interface Args {
  group?: string;
  calculator?: string;
  requireSourceVerified: boolean;
  requireScenarioVerified: boolean;
  releaseAttestation?: ReleaseEvidenceAttestation;
}

function usage(): void {
  process.stderr.write('Usage: npm run validate:clinical -- [--group ID | --calculator ID] [--require-source-verified] [--require-scenario-verified] [--release-attestation PATH]\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = { requireSourceVerified: false, requireScenarioVerified: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--group') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--group requires a value');
      args.group = value;
      index += 1;
    } else if (token === '--calculator') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--calculator requires a value');
      args.calculator = value;
      index += 1;
    } else if (token === '--require-source-verified') {
      args.requireSourceVerified = true;
    } else if (token === '--require-scenario-verified') {
      args.requireScenarioVerified = true;
    } else if (token === '--release-attestation') {
      const path = argv[index + 1];
      if (path === undefined) throw new Error('--release-attestation requires a path');
      args.releaseAttestation = ReleaseEvidenceAttestationSchema.parse(parseYaml(readFileSync(path, 'utf8')));
      index += 1;
    } else {
      throw new Error(`unknown option '${token}'`);
    }
  }
  if (args.group !== undefined && args.calculator !== undefined) {
    throw new Error('choose either --group or --calculator');
  }
  return args;
}

export async function validateClinical(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    usage();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const needsRunner = args.requireScenarioVerified || args.releaseAttestation !== undefined;
    const runner = needsRunner
      ? await (await import('../server/validation-case-runner.js')).createValidationCaseRunner()
      : undefined;
    try {
      const report = await validateClinicalCatalog({
        ...(args.group === undefined ? {} : { group: args.group }),
        ...(args.calculator === undefined ? {} : { calculator: args.calculator }),
        requireSourceVerified: args.requireSourceVerified,
        requireScenarioVerified: args.requireScenarioVerified,
        ...(args.releaseAttestation === undefined ? {} : { releaseAttestation: args.releaseAttestation }),
        ...(runner === undefined ? {} : { caseRunner: runner }),
      });
      const summary = `${report.calculatorReports.length} dossiers; ${report.groupReports.length} complete groups; gate=${report.requestedGate}; errors=${report.errors.length}`;
      (report.ok ? process.stdout : process.stderr).write(`${report.ok ? 'PASS' : 'FAIL'} clinical validation: ${summary}\n`);
      return report.ok ? 0 : 1;
    } finally {
      await runner?.close();
    }
  } catch (error) {
    process.stderr.write(`Clinical validation configuration error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
