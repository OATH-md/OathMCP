const FORBIDDEN_ORIGIN_BODY = 'Forbidden origin.';

/** Parse a comma-separated exact-origin allowlist. Empty entries are ignored. */
export function parseAllowedOrigins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
}

/**
 * Non-browser MCP clients commonly omit Origin and remain allowed. Any browser
 * Origin must match an explicitly configured origin byte-for-byte.
 */
export function originRejection(
  origin: string | null,
  allowed: ReadonlySet<string>,
): { status: 403; body: string } | null {
  if (origin === null || origin.length === 0 || allowed.has(origin)) return null;
  return { status: 403, body: FORBIDDEN_ORIGIN_BODY };
}
