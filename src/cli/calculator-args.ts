import { CalculatorIdSchema } from '../validation/draft-schema.js';

export function parseCalculatorIdArg(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--id' || argv[1] === undefined) {
    throw new Error('expected --id ID');
  }
  return CalculatorIdSchema.parse(argv[1]);
}
