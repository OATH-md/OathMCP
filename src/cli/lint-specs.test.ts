import { describe, expect, it, vi } from 'vitest';
import { lintSpecs, registeredComputeIdsFromSources } from './lint-specs.js';

describe('lint-specs command', () => {
  it('discovers registered computes independently of the generated index', () => {
    expect(
      registeredComputeIdsFromSources({
        'bmi.ts': "registerCompute('bmi', bmi);",
        'orphan.ts': "registerCompute('orphan', orphan);",
        'round.ts': 'export function round() {}',
      }),
    ).toEqual(['bmi', 'orphan']);
  });

  it('accepts the complete repository catalog', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(lintSpecs([])).resolves.toBe(0);
    expect(output).toHaveBeenCalledWith('Validated 40 calculator specs.\n');

    output.mockRestore();
  });
});
