const PLACEHOLDER_RE = /{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g;

/** Parse all valid placeholders and reject unmatched or malformed braces. */
export function templatePlaceholders(template: string): string[] {
  const names = [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1]);
  const remainder = template.replace(PLACEHOLDER_RE, '');
  if (remainder.includes('{{') || remainder.includes('}}')) {
    throw new Error('Malformed prompt placeholder');
  }
  return names;
}

/** Fill a validated prompt template from normalized string values. */
export function fillTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  templatePlaceholders(template);
  return template.replace(
    PLACEHOLDER_RE,
    (_, key: string) => values[key] ?? 'not available for this result',
  );
}
