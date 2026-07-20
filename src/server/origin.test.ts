import { describe, expect, it } from 'vitest';
import { originRejection, parseAllowedOrigins } from './origin.js';

describe('Origin policy', () => {
  it('parses an exact comma-separated allowlist and ignores empty entries', () => {
    expect([...parseAllowedOrigins(' https://app.example,https://review.example, ,')]).toEqual([
      'https://app.example',
      'https://review.example',
    ]);
    expect(parseAllowedOrigins(undefined).size).toBe(0);
  });

  it('allows absent Origin but rejects every nonempty Origin not explicitly listed', () => {
    const allowed = parseAllowedOrigins('https://app.example');
    expect(originRejection(null, allowed)).toBeNull();
    expect(originRejection('', allowed)).toBeNull();
    expect(originRejection('https://app.example', allowed)).toBeNull();
    expect(originRejection('https://APP.example', allowed)).toEqual({
      status: 403,
      body: 'Forbidden origin.',
    });
    expect(originRejection('https://evil.example', allowed)).toEqual({
      status: 403,
      body: 'Forbidden origin.',
    });
  });

  it('does not treat a wildcard token as a permissive origin rule', () => {
    expect(originRejection('https://app.example', parseAllowedOrigins('*'))).not.toBeNull();
  });
});
