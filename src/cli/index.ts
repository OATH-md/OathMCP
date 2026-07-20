#!/usr/bin/env node
/**
 * oath-mcp CLI — dispatches maintenance subcommands (the MCP servers
 * have their own entry points under src/server/). Kept separate from the engine
 * and server layers. This is a repository-local authoring and validation
 * entrypoint; the published `oath-mcp` binary starts the stdio server.
 */
import { bundleSpecs } from './bundle-specs.js';
import { lintSpecs } from './lint-specs.js';

type Command = (argv: string[]) => number | Promise<number>;

const SUBCOMMANDS: Record<string, Command> = {
  'bundle-specs': bundleSpecs,
  'lint-specs': lintSpecs,
  'validate-clinical': async (argv) =>
    (await import('./validate-clinical.js')).validateClinical(argv),
  'new-calculator': async (argv) => (await import('./new-calculator.js')).scaffoldCalculator(argv),
  'check-calculator': async (argv) => (await import('./check-calculator.js')).checkCalculator(argv),
  'promote-calculator': async (argv) => (await import('./promote-calculator.js')).promoteCalculator(argv),
};

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h') {
    process.stdout.write(`Usage: npx tsx src/cli/index.ts <command> [args]\n\nCommands:\n  ${Object.keys(SUBCOMMANDS).join('\n  ')}\n`);
    return name === undefined ? 1 : 0;
  }
  const command = SUBCOMMANDS[name];
  if (command === undefined) {
    process.stderr.write(`Unknown command: ${name}\nRun with --help to list commands.\n`);
    return 1;
  }
  return command(rest);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
