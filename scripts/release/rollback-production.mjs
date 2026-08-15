import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { restoreProduction } from './deploy-production.mjs';

export function parseRollbackArgs(argv) {
  const options = { baseUrl: 'https://mcp.oath.md' };
  const names = new Map([
    ['--tag', 'tag'],
    ['--sha', 'sha'],
    ['--mcp-version-id', 'mcpVersionId'],
    ['--docs-version-id', 'docsVersionId'],
    ['--expected-version', 'expectedVersion'],
    ['--base-url', 'baseUrl'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const name = names.get(token);
    if (name === undefined) throw new Error(`Unknown option '${token}'`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function runCli() {
  await restoreProduction(parseRollbackArgs(process.argv.slice(2)));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runCli();
}
