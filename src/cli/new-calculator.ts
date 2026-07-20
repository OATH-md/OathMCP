import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALCULATOR_ARCHETYPES, CalculatorArchetypeSchema, CalculatorIdSchema, type CalculatorArchetype } from '../validation/draft-schema.js';
import { DRAFTS_DIR, TEMPLATES_DIR } from './calculator-files.js';

function parse(argv: string[]): { id: string; archetype: CalculatorArchetype } {
  let id: string | undefined;
  let archetype: CalculatorArchetype | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag ?? 'argument'} requires a value`);
    if (flag === '--id') id = value;
    else if (flag === '--archetype') archetype = CalculatorArchetypeSchema.parse(value);
    else throw new Error(`unknown or invalid option '${flag} ${value}'`);
  }
  if (id === undefined || archetype === undefined) throw new Error('--id and --archetype are required');
  return { id: CalculatorIdSchema.parse(id), archetype };
}

export function scaffoldCalculator(argv: string[]): number {
  let args: ReturnType<typeof parse>;
  try { args = parse(argv); } catch (error) {
    process.stderr.write(`Usage: npm run new:calculator -- --id ID --archetype ${CALCULATOR_ARCHETYPES.join('|')}\n${String(error)}\n`);
    return 2;
  }
  const target = join(DRAFTS_DIR, args.id);
  if (existsSync(target)) {
    process.stderr.write(`Draft '${args.id}' already exists; refusing to overwrite.\n`);
    return 1;
  }
  const template = join(TEMPLATES_DIR, args.archetype);
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(template)) {
    writeFileSync(join(target, file), readFileSync(join(template, file), 'utf8').replaceAll('__CALCULATOR_ID__', args.id));
  }
  process.stdout.write(`Created draft calculator at drafts/calculators/${args.id}/\n`);
  return 0;
}
