import { validateDraftForProduction, type DraftCalculator } from '../validation/draft-schema.js';
import { parseCalculatorIdArg } from './calculator-args.js';
import { cleanupPreflight, installPreflight, liveCandidateExists, loadDraftCalculator, preflightCandidate, PromotionRollbackError } from './calculator-files.js';

export function promoteCalculator(argv: string[]): number {
  let id: string;
  try { id = parseCalculatorIdArg(argv); } catch (error) {
    process.stderr.write(`Usage: npm run promote:calculator -- --id ID\n${String(error)}\n`); return 2;
  }
  if (liveCandidateExists(id)) {
    process.stderr.write(`Live calculator '${id}' already exists; refusing to overwrite.\n`); return 1;
  }
  let draft: DraftCalculator;
  try { draft = loadDraftCalculator(id); } catch (error) {
    process.stderr.write(`Draft '${id}' load error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const result = validateDraftForProduction(draft);
    if (result.candidate === undefined) {
      process.stderr.write(`Draft '${id}' cannot be promoted:\n- ${result.issues.join('\n- ')}\n`); return 1;
    }
    const preflight = preflightCandidate(result.candidate);
    try {
      installPreflight(preflight);
    } catch (error) {
      if (error instanceof PromotionRollbackError) {
        const backups = error.preservedBackupPaths.length > 0
          ? ` Preserved backups: ${error.preservedBackupPaths.join(', ')}`
          : '';
        process.stderr.write(`Promotion install failed and rollback was incomplete; manual recovery is required.${backups}\n`);
      } else {
        process.stderr.write(`Promotion install failed; live catalog was rolled back: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      return 1;
    } finally {
      cleanupPreflight(preflight);
    }
    process.stdout.write(`Promoted '${id}' after isolated strict, type, engine, MCP, source, and scenario verification.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Promotion preflight failed; no live candidate files were written: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
