import { describe, expect, it } from 'vitest';
import {
  assertNamingConventions,
  assertSharedInputCompatibility,
} from './lint-specs.js';

describe('catalog-wide spec linting', () => {
  it('rejects incompatible shapes for a pooled panel input', () => {
    expect(() =>
      assertSharedInputCompatibility([
        { id: 'a', inputs: { sodium: { conceptId: 'lab.sodium', sharedKey: 'sodium', kind: 'number' } } },
        {
          id: 'b',
          inputs: {
            sodium: {
              conceptId: 'lab.sodium',
              sharedKey: 'sodium',
              kind: 'quantity',
              quantity: { canonicalUnit: 'mEq/L' },
            },
          },
        },
      ]),
    ).toThrow(/sodium: lab.sodium:number .* lab.sodium:quantity:mEq\/L/);
  });

  it('accepts compatible pooled inputs', () => {
    expect(() =>
      assertSharedInputCompatibility([
        {
          id: 'a',
          inputs: {
            sodium: {
              conceptId: 'lab.sodium',
              sharedKey: 'sodium',
              kind: 'quantity',
              quantity: { canonicalUnit: 'mEq/L' },
            },
          },
        },
        {
          id: 'b',
          inputs: {
            sodium: {
              conceptId: 'lab.sodium',
              sharedKey: 'sodium',
              kind: 'quantity',
              quantity: { canonicalUnit: 'mEq/L' },
            },
          },
        },
      ]),
    ).not.toThrow();
  });

  it('rejects replaced input ids and display-form enum values', () => {
    expect(() =>
      assertNamingConventions([
        {
          id: 'example',
          inputs: {
            gender: {
              title: 'Gender',
              kind: 'enum',
              enumValues: [{ value: 'Adult Male' }],
            },
          },
          outputs: { score: { title: 'Score' } },
        },
      ]),
    ).toThrow(/use 'sex'.*lowercase snake_case/);
  });

  it('rejects non-canonical calculator/output ids and prefixed boolean ids', () => {
    expect(() =>
      assertNamingConventions([
        {
          id: 'Bad-Calculator',
          inputs: {
            is_active: { title: 'Active Condition', kind: 'boolean' },
          },
          outputs: { BadOutput: { title: 'Result' } },
        },
      ]),
    ).toThrow(
      /calculator ids must use lowercase snake_case.*boolean ids must use a positive-condition noun.*output ids must use lowercase snake_case/,
    );
  });

  it('rejects unit-only title parentheticals on inputs and outputs', () => {
    expect(() =>
      assertNamingConventions([
        {
          id: 'example',
          inputs: {
            height_cm: { title: 'Height (cm)', kind: 'number' },
          },
          outputs: { clearance: { title: 'Clearance (mL/min)' } },
        },
      ]),
    ).toThrow(/input titles must not repeat.*output titles must not repeat/);
  });

  it('accepts canonical ids, numeric enum tokens, and semantic parentheticals', () => {
    expect(() =>
      assertNamingConventions([
        {
          id: 'example',
          inputs: {
            weight_kg: { title: 'Weight', kind: 'number' },
            appearance: {
              title: 'Appearance (Skin Color)',
              kind: 'enum',
              enumValues: [{ value: 'pink_all_over' }],
            },
            active_cancer: {
              title: 'Active cancer (treatment ongoing, within 6 months, or palliative)',
              kind: 'boolean',
            },
            baseline_incidence: {
              title: 'Baseline Incidence',
              kind: 'enum',
              enumValues: [{ value: 'well_appearing' }, { value: '0.3' }],
            },
          },
          outputs: { kdri_scaled: { title: 'KDRI (Scaled)' } },
        },
      ]),
    ).not.toThrow();
  });
});
