import { describe, expect, it } from 'vitest';
import { fillTemplate, templatePlaceholders } from './prompt-template.js';

describe('prompt template interface', () => {
  it('uses the same whitespace-tolerant grammar for linting and rendering', () => {
    expect(templatePlaceholders('Result: {{ result }}')).toEqual(['result']);
    expect(fillTemplate('Result: {{ result }}', { result: '42' })).toBe(
      'Result: 42',
    );
  });

  it('rejects malformed brace expressions', () => {
    expect(() => templatePlaceholders('Result: {{ result')).toThrow(
      /Malformed prompt placeholder/,
    );
  });
});
