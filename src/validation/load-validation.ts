import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import {
  AuthoritySourceSchema,
  ValidationCatalogSchema,
  ValidationDossierSchema,
  type AuthoritySource,
  type ValidationCatalog,
  type ValidationDossier,
  type ReferenceCase,
} from './schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const VALIDATION_DIR = join(ROOT, 'validation');

function parseFile(path: string): unknown {
  return parseYaml(readFileSync(path, 'utf8')) as unknown;
}

export function loadValidationCatalog(): ValidationCatalog {
  return ValidationCatalogSchema.parse(parseFile(join(VALIDATION_DIR, 'catalog.yaml')));
}

export function loadValidationDossiers(): Map<string, ValidationDossier> {
  const directory = join(VALIDATION_DIR, 'calculators');
  const dossiers = new Map<string, ValidationDossier>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.yaml')).sort()) {
    const dossier = ValidationDossierSchema.parse(parseFile(join(directory, file)));
    if (file.replace(/\.yaml$/, '') !== dossier.calculatorId) {
      throw new Error(`${file}: filename must match calculatorId '${dossier.calculatorId}'`);
    }
    if (dossiers.has(dossier.calculatorId)) throw new Error(`duplicate dossier '${dossier.calculatorId}'`);
    dossiers.set(dossier.calculatorId, dossier);
  }
  return dossiers;
}

/** Current source-linked reference cases used as public and test oracles. */
export function loadAuthoritativeReferenceCases(calculatorId: string): readonly ReferenceCase[] {
  if (!/^[a-z][a-z0-9_]*$/.test(calculatorId)) throw new Error(`Invalid calculator id '${calculatorId}'`);
  const dossier = ValidationDossierSchema.parse(parseFile(join(VALIDATION_DIR, 'calculators', `${calculatorId}.yaml`)));
  if (dossier.calculatorId !== calculatorId) throw new Error(`Dossier id mismatch for '${calculatorId}'`);
  return dossier.cases.filter((testCase): testCase is ReferenceCase => testCase.kind === 'reference');
}

export function loadAuthorityRegistry(): Map<string, AuthoritySource> {
  const parsed = parseFile(join(VALIDATION_DIR, 'authorities.yaml'));
  const registry = ValidationCatalogAuthoritiesSchema.parse(parsed);
  if (new Set(registry.authorities.map((authority) => authority.id)).size !== registry.authorities.length) {
    throw new Error('authority registry contains duplicate IDs');
  }
  return new Map(registry.authorities.map((authority) => [authority.id, authority]));
}

const ValidationCatalogAuthoritiesSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  authorities: z.array(AuthoritySourceSchema),
});
