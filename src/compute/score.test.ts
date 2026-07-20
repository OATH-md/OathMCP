import { describe, expect, it } from 'vitest';
import { loadSpec, loadSpecs } from '../engine/load-specs.js';
import { run } from '../engine/run.js';
import { scoreBreakdown, sumDeclaredScore } from './score.js';
import type { CalculatorInputsById } from './types.generated.js';
import { loadAuthoritativeReferenceCases } from '../validation/load-validation.js';

describe('declarative score engine', () => {
  it('preserves declared component order, labels, and PEWS +2 modifiers', () => {
    const inputs: CalculatorInputsById['pews'] = {
      behavior: 'lethargic', cardiovascular: 'gray_mottled',
      respiratory: 'severe_distress', nebulizers: true, vomiting: true,
    };
    const result = sumDeclaredScore('pews', inputs);
    expect(result.total).toBe(13);
    expect(result.components.map(({ field, points }) => [field, points])).toEqual([
      ['behavior', 3], ['cardiovascular', 3], ['respiratory', 3],
      ['nebulizers', 2], ['vomiting', 2],
    ]);
    expect(result.components.every((component) => component.label.length > 0)).toBe(true);
  });

  it('preserves Wells negative weight and its full -2 to 9 range', () => {
    const base = Object.fromEntries(Object.keys(loadSpec('wells_dvt').inputs).map((field) => [field, false]));
    const minimum = sumDeclaredScore('wells_dvt', { ...base, alternative_diagnosis: true } as CalculatorInputsById['wells_dvt']);
    const maximum = sumDeclaredScore('wells_dvt', { ...base, ...Object.fromEntries(Object.keys(base).map((field) => [field, field !== 'alternative_diagnosis'])) } as CalculatorInputsById['wells_dvt']);
    expect(minimum.total).toBe(-2);
    expect(minimum.components.find((component) => component.field === 'alternative_diagnosis')?.points).toBe(-2);
    expect(maximum.total).toBe(9);
  });

  it('derives qSOFA numeric-threshold components at exact boundaries', () => {
    const result = sumDeclaredScore('qsofa', {
      respiratory_rate: 22, systolic_bp: 100, altered_mental_status: false,
    });
    expect(result.total).toBe(2);
    expect(result.components.map((component) => component.points)).toEqual([1, 1, 0]);
  });

  it('marks GCS Not Testable without substituting a score or total', () => {
    const result = run('gcs', {
      assessment_context: 'acute_brain_injury',
      modifier_context: 'intubation_or_tracheostomy',
      eye_opening: 'to_speech',
      verbal_response: 'not_testable_intubation',
      motor_response: 'localizes_to_pain',
    });
    expect(result.scoreComplete).toBe(false);
    expect(result.results.map((entry) => entry.name)).not.toContain('gcs_total');
    expect(result.results.map((entry) => entry.name)).not.toContain('verbal_score');
    const verbal = result.scoringComponents.find((component) => component.field === 'verbal_response');
    expect(verbal).toMatchObject({ testable: false });
    expect(verbal).not.toHaveProperty('points');
  });

  it('marks NIHSS physical barriers untestable and says zero does not exclude stroke', () => {
    const baseline = loadAuthoritativeReferenceCases('nihss')[0]?.inputs as CalculatorInputsById['nihss'];
    const incomplete = run('nihss', { ...baseline, modifier_context: 'intubation', dysarthria: 'intubated' });
    expect(incomplete.scoreComplete).toBe(false);
    expect(incomplete.results.map((entry) => entry.name)).not.toContain('nihss_score');

    const zero = run('nihss', baseline);
    expect(zero.results.find((entry) => entry.name === 'nihss_score')?.value).toBe(0);
    expect(loadSpec('nihss').outputs.nihss_score.description).toContain('stroke is not excluded');
  });

  it('keeps a 47-hour Ranson assessment incomplete and completes the correct variant at 48 hours', () => {
    const completeNonGallstone = loadAuthoritativeReferenceCases('ranson')[0]?.inputs as CalculatorInputsById['ranson'];
    const {
      followup_observed_at_hours: _followupObservedAtHours,
      hematocrit_followup: _hematocritFollowup,
      bun_followup: _bunFollowup,
      calcium_followup: _calciumFollowup,
      pao2_followup: _pao2Followup,
      base_deficit_followup: _baseDeficitFollowup,
      fluid_sequestration_followup: _fluidSequestrationFollowup,
      ...admissionInputs
    } = completeNonGallstone;
    const at47 = run('ranson', { ...admissionInputs, assessment_hours: 47 });
    expect(at47.results.map((entry) => entry.name)).not.toContain('score');
    expect(at47.results.find((entry) => entry.name === 'admission_subtotal')?.value).toBe(0);
    expect(at47.scoreComplete).toBe(false);

    const gallstone = run('ranson', loadAuthoritativeReferenceCases('ranson')[1]?.inputs ?? {});
    expect(gallstone.results.find((entry) => entry.name === 'score')?.value).toBe(0);
    expect(gallstone.results.find((entry) => entry.name === 'criterion_provenance')?.value)
      .toEqual(expect.arrayContaining([expect.objectContaining({ criterion: 'pao2', state: 'not_applicable' })]));
    expect(gallstone.scoreComplete).toBe(true);
  });

  it('returns a breakdown for every declared score component', () => {
    for (const spec of [...loadSpecIdsWithScoring()]) {
      const input = loadAuthoritativeReferenceCases(spec.id).find((vector) => {
        try { return scoreBreakdown(spec.id as never, vector.inputs as never).complete; } catch { return false; }
      })?.inputs;
      if (input === undefined) continue;
      expect(scoreBreakdown(spec.id as never, input as never).components.map((component) => component.field))
        .toEqual(spec.scoring?.components.map((component) => component.field));
    }
  });

  it('exercises every declared enum option and both states of every boolean component', () => {
    for (const spec of loadSpecIdsWithScoring()) {
      const baseline = loadAuthoritativeReferenceCases(spec.id).find((vector) => {
        try { return scoreBreakdown(spec.id as never, vector.inputs as never).complete; } catch { return false; }
      })?.inputs;
      expect(baseline, `${spec.id}: complete baseline`).toBeDefined();
      if (baseline === undefined) continue;

      for (const component of spec.scoring?.components ?? []) {
        const input = spec.inputs[component.field];
        if (component.kind === 'enum' && input.kind === 'enum') {
          for (const option of input.enumValues) {
            const result = scoreBreakdown(spec.id as never, { ...baseline, [component.field]: option.value } as never);
            const selected = result.components.find((entry) => entry.field === component.field);
            expect(selected?.testable, `${spec.id}.${component.field}.${option.value}`)
              .toBe(option.scorable !== false);
            expect(selected?.points).toBe(option.points);
          }
        } else if (component.kind === 'boolean') {
          for (const value of [false, true]) {
            const result = scoreBreakdown(spec.id as never, { ...baseline, [component.field]: value } as never);
            expect(result.components.find((entry) => entry.field === component.field)?.points)
              .toBe(value ? component.truePoints : component.falsePoints);
          }
        } else if (component.kind === 'threshold') {
          const values = component.operator === 'gte'
            ? [component.threshold - 1, component.threshold, component.threshold + 1]
            : [component.threshold + 1, component.threshold, component.threshold - 1];
          expect(values.map((value) => scoreBreakdown(spec.id as never, { ...baseline, [component.field]: value } as never)
            .components.find((entry) => entry.field === component.field)?.points))
            .toEqual([component.falsePoints, component.truePoints, component.truePoints]);
        }
      }
    }
  });
});

function loadSpecIdsWithScoring() {
  return [...loadSpecs().values()].filter((spec) => spec.scoring !== undefined);
}
