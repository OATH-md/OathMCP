import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { validateSpecTexts } from './load-specs.js';

const sourceId = 'source_1';
const band = (when: string, code = 'sample_band') => ({
  code, kind: 'status', when, label: when, severity: 'normal', evidenceRefs: [sourceId],
});
const validSpec = {
  id: 'sample', version: '1.0.0', name: 'Sample calculator',
  clinicalModel: { modelKind: 'formula', modelId: 'sample', modelVersion: '1', reviewDate: '2026-07-15', evidenceRefs: [sourceId] },
  applicability: { population: 'Sample population.', setting: 'Testing.', exclusions: [], evidenceRefs: [sourceId] },
  purposeForAgents: 'Exercise the strict spec-validation interface.',
  evidence: [{ id: sourceId, type: 'reference', citation: 'Example reference.', locator: 'section 1', url: 'https://example.com/reference', reviewed: true }],
  inputs: {
    value: {
      title: 'Value', description: 'Input value.', conceptId: 'sample.input.value', sharedKey: 'value',
      kind: 'number', plausible: [0, 10], hardLimits: [-10, 20], required: true,
      examples: [1], sourceRefs: [sourceId],
    },
  },
  outputs: {
    result: {
      title: 'Result', description: 'Computed result.', kind: 'number',
      availability: { kind: 'always' }, evidenceRefs: [sourceId],
    },
  },
  primaryOutputs: ['result'],
  interpretationBands: [band('>=5', 'sample_high'), band('<5', 'sample_low')],
  prompt: { description: 'Interpret the result.', template: 'Input {{value}} produced {{result}}.' },
};

function source(spec: Record<string, unknown> = validSpec): Record<string, string> {
  return { [`${String(spec.id ?? 'sample')}.yaml`]: stringify(spec) };
}
function mutate(callback: (spec: any) => void): Record<string, string> {
  const spec = structuredClone(validSpec);
  callback(spec);
  return source(spec);
}

describe('strict spec authoring', () => {
  it('accepts the complete strict contract', () => {
    expect(() => validateSpecTexts(source())).not.toThrow();
  });

  it('orders validated specs by filename regardless of source insertion order', () => {
    const rFactor = structuredClone(validSpec);
    rFactor.id = 'r_factor';
    rFactor.clinicalModel.modelId = 'r_factor';
    const ranson = structuredClone(validSpec);
    ranson.id = 'ranson';
    ranson.clinicalModel.modelId = 'ranson';

    const specs = validateSpecTexts({
      'ranson.yaml': stringify(ranson),
      'r_factor.yaml': stringify(rFactor),
    });

    expect([...specs.keys()]).toEqual(['r_factor', 'ranson']);
  });

  it.each([
    ['top-level', (spec: any) => { spec.unexpected = true; }],
    ['misspelled input', (spec: any) => { spec.inputs.value.hardLimit = [0, 1]; }],
    ['unknown output', (spec: any) => { spec.outputs.result.units = 'mg'; }],
  ])('rejects an unknown %s key', (_label, change) => {
    expect(() => validateSpecTexts(mutate(change))).toThrow(/unrecognized|Unrecognized|unknown/i);
  });

  it('rejects fields irrelevant to an input kind', () => {
    expect(() => validateSpecTexts(mutate((spec) => {
      spec.inputs.value.enumValues = [{ value: 'x', label: 'X', description: 'X.' }];
    }))).toThrow(/enumValues/);
  });

  it('requires snapshot, effective, and review metadata for lookup models', () => {
    expect(() => validateSpecTexts(mutate((spec) => {
      spec.clinicalModel.modelKind = 'lookup';
      delete spec.clinicalModel.reviewDate;
    }))).toThrow(/dataSnapshot|effectiveDate|reviewDate/);
  });

  it.each(['evidence', 'inputs', 'outputs'])('rejects an empty %s collection', (field) => {
    expect(() => validateSpecTexts(mutate((spec) => { spec[field] = field === 'evidence' ? [] : {}; }))).toThrow(new RegExp(field));
  });

  it('rejects duplicate enum tokens and incomplete option metadata', () => {
    expect(() => validateSpecTexts(mutate((spec) => {
      spec.inputs.value = {
        title: 'Value', description: 'Option.', conceptId: 'sample.input.value', kind: 'enum',
        required: true, examples: ['low'], sourceRefs: [sourceId],
        enumValues: [
          { value: 'low', label: 'Low', description: 'Low.' },
          { value: 'low', label: 'Duplicate', description: 'Duplicate.' },
        ],
      };
    }))).toThrow(/unique/);
  });

  it('rejects dangling evidence and availability references', () => {
    expect(() => validateSpecTexts(mutate((spec) => {
      spec.outputs.result.evidenceRefs = ['missing_source'];
      spec.outputs.result.availability = { kind: 'whenAnyInputPresent', fields: ['missing_input'] };
    }))).toThrow(/unknown evidence reference|unknown input/);
  });

  it('validates temporal observation metadata and structured criterion outputs', () => {
    expect(() => validateSpecTexts(mutate((spec) => {
      spec.inputs.observed_at = {
        title: 'Observed At', description: 'Hours since admission.', conceptId: 'sample.input.observed_at',
        kind: 'integer', hardLimits: [0, 48], required: true, examples: [0], sourceRefs: [sourceId],
      };
      spec.inputs.value.observation = {
        phase: 'follow_up', timestampField: 'observed_at', derivation: 'threshold',
      };
      spec.outputs.result = {
        ...spec.outputs.result,
        kind: 'criterion_list',
      };
      spec.constraints = [{
        kind: 'forbidPresentWhen', field: 'observed_at', when: '<48', forbidden: ['value'],
        message: 'The observation is not due.',
      }];
    }))).not.toThrow();

    expect(() => validateSpecTexts(mutate((spec) => {
      spec.inputs.value.observation = {
        phase: 'follow_up', timestampField: 'missing_timestamp', derivation: 'change_from_baseline',
      };
    }))).toThrow(/baselineField|timestampField/);
  });

  it('rejects missing, duplicate, or unknown primary outputs', () => {
    expect(() => validateSpecTexts(mutate((spec) => { spec.primaryOutputs = ['missing']; }))).toThrow(/unknown primary output/);
    expect(() => validateSpecTexts(mutate((spec) => { spec.primaryOutputs = []; }))).toThrow(/primaryOutputs/);
  });

  it('requires explicit completion metadata to reference compatible outputs', () => {
    expect(() => validateSpecTexts(mutate((spec) => {
      spec.outputs.complete = {
        title: 'Complete', description: 'Whether the assessment is complete.',
        kind: 'boolean', availability: { kind: 'always' }, evidenceRefs: [sourceId],
      };
      spec.outputs.reasons = {
        title: 'Reasons', description: 'Reasons the assessment is incomplete.',
        kind: 'string_list', availability: { kind: 'always' }, evidenceRefs: [sourceId],
      };
      spec.completion = { completeOutput: 'complete', missingReasonsOutput: 'reasons' };
    }))).not.toThrow();

    expect(() => validateSpecTexts(mutate((spec) => {
      spec.completion = { completeOutput: 'result', missingReasonsOutput: 'missing' };
    }))).toThrow(/completeOutput|missingReasonsOutput/);
  });

  it('rejects incomplete scoring ranges and type-incompatible adjustments', () => {
    expect(() => validateSpecTexts(mutate((spec) => {
      spec.scoring = {
        output: 'result', range: [0, 2], evidenceRefs: [sourceId],
        components: [{ kind: 'boolean', field: 'value', truePoints: 1, falsePoints: 0 }],
      };
      spec.adjustments = [{ id: 'bad', operation: 'cap', target: { kind: 'input', field: 'missing' }, maximum: 5, evidenceRefs: [sourceId] }];
    }))).toThrow(/boolean component requires boolean input|scoring.range/);
  });

  it('rejects duplicate or optional-without-default scoring components', () => {
    const scored = (spec: any): void => {
      spec.inputs.value = {
        title: 'Value', description: 'Criterion.', conceptId: 'sample.input.value',
        kind: 'boolean', required: true, examples: [false], sourceRefs: [sourceId],
      };
      spec.outputs.result.kind = 'integer';
      spec.scoring = {
        output: 'result', range: [0, 1], evidenceRefs: [sourceId],
        components: [{ kind: 'boolean', field: 'value', truePoints: 1, falsePoints: 0 }],
      };
    };
    expect(() => validateSpecTexts(mutate((spec) => {
      scored(spec);
      spec.scoring.components.push({ kind: 'boolean', field: 'value', truePoints: 1, falsePoints: 0 });
      spec.scoring.range = [0, 2];
    }))).toThrow(/component fields must be unique/);
    expect(() => validateSpecTexts(mutate((spec) => {
      scored(spec);
      spec.inputs.value.required = false;
    }))).toThrow(/required or defaulted/);
  });

  it('rejects prompt and band references outside the interface', () => {
    expect(() => validateSpecTexts(mutate((spec) => { spec.prompt.template = '{{missing}}'; }))).toThrow(/unknown placeholder/);
    expect(() => validateSpecTexts(mutate((spec) => { spec.interpretationBands = [band('>5'), band('<5', 'low')]; }))).toThrow(/no band matches value 5/);
  });

  it('rejects the removed runtime fixture field', () => {
    const removedKey = ['golden', 'Tests'].join('');
    expect(() => validateSpecTexts(mutate((spec) => {
      spec[removedKey] = [{ inputs: { value: 1 }, expect: { result: 1 }, source: 'Removed fixture.' }];
    }))).toThrow(/unrecognized|Unrecognized|unknown/i);
  });

  it('rejects same shared key with different clinical concepts', () => {
    const second = structuredClone(validSpec);
    second.id = 'second';
    second.clinicalModel.modelId = 'second';
    second.inputs.value.conceptId = 'second.input.value';
    expect(() => validateSpecTexts({ ...source(), 'second.yaml': stringify(second) })).toThrow(/Shared input compatibility failed/);
  });

  it('rejects self, cyclic, non-reciprocal, and duplicate lifecycle identities', () => {
    expect(() => validateSpecTexts(mutate((spec) => {
      spec.family = 'sample_family';
      spec.variant = 'v1';
      spec.supersedes = ['sample'];
      spec.supersededBy = ['sample'];
    }))).toThrow(/point to self|cycle/);

    const first: any = structuredClone(validSpec);
    first.id = 'first';
    first.family = 'sample_family';
    first.variant = 'v1';
    delete first.inputs.value.sharedKey;
    first.clinicalModel.modelId = 'first';
    first.supersedes = ['second'];
    const second: any = structuredClone(validSpec);
    second.id = 'second';
    second.family = 'sample_family';
    second.variant = 'v1';
    delete second.inputs.value.sharedKey;
    second.clinicalModel.modelId = 'second';
    second.supersedes = ['first'];
    expect(() => validateSpecTexts({
      'first.yaml': stringify(first),
      'second.yaml': stringify(second),
    })).toThrow(/reciprocal|already owned|cycle/);
  });
});
