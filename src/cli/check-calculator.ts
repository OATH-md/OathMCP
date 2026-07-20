import { validateDraftForProduction, type DraftCalculator } from '../validation/draft-schema.js';
import { parseCalculatorIdArg } from './calculator-args.js';
import { cleanupPreflight, loadDraftCalculator, preflightCandidate } from './calculator-files.js';

export function checkCalculator(argv: string[]): number {
  let id: string;
  try { id = parseCalculatorIdArg(argv); } catch (error) {
    process.stderr.write(`Usage: npm run check:calculator -- --id ID\n${String(error)}\n`); return 2;
  }
  let draft: DraftCalculator;
  try { draft = loadDraftCalculator(id); } catch (error) {
    process.stderr.write(`Draft '${id}' load error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const result = validateDraftForProduction(draft);
    if (result.candidate === undefined) {
      process.stderr.write(`Draft '${id}' is incomplete:\n- ${result.issues.join('\n- ')}\n`); return 1;
    }
    const preflight = preflightCandidate(result.candidate);
    cleanupPreflight(preflight);
    process.stdout.write(`Draft '${id}' passes strict spec, type, engine, MCP, source, and scenario checks.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Draft '${id}' check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
