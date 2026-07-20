/** Exact media-type checks for the MCP Streamable HTTP boundary. */

export const MAX_MCP_REQUEST_BYTES = 100 * 1024;

function normalizedMediaType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

export function acceptsMediaType(
  header: string | null | undefined,
  required: string,
): boolean {
  if (header === null || header === undefined) return false;
  const normalizedRequired = required.toLowerCase();
  return header.split(',').some((range) => {
    const parts = range.split(';').map((part) => part.trim());
    if (parts[0]?.toLowerCase() !== normalizedRequired) return false;
    const quality = parts.find((part) => /^q\s*=/i.test(part));
    if (quality === undefined) return true;
    const value = Number(quality.slice(quality.indexOf('=') + 1).trim());
    return Number.isFinite(value) && value > 0;
  });
}

export function isJsonContentType(header: string | null | undefined): boolean {
  if (header === null || header === undefined ||
    normalizedMediaType(header) !== 'application/json') return false;
  const charset = header
    .split(';')
    .slice(1)
    .map((parameter) => parameter.trim())
    .find((parameter) => /^charset\s*=/i.test(parameter));
  if (charset === undefined) return true;
  const value = charset.slice(charset.indexOf('=') + 1).trim().replace(/^"|"$/g, '').toLowerCase();
  return value === 'utf-8' || value === 'utf8';
}

export function isIdentityContentEncoding(header: string | null | undefined): boolean {
  return header === null || header === undefined || header.trim().toLowerCase() === 'identity';
}
