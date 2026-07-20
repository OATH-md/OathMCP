import { describe, expect, it } from 'vitest';
import { loadSpecs } from '../engine/load-specs.js';
import { createCalculatorSearch } from './calculator-search.js';

const search = createCalculatorSearch([...loadSpecs().values()]);

describe('agent-first calculator discovery', () => {
  it.each([
    ['bmi', 'bmi'],
    ['Body Mass Index (BMI)', 'bmi'],
    ['CKD', 'gfr'],
    ['kidney function', 'gfr'],
    ['AF stroke risk', 'chadsvasc'],
  ])('makes exact declared identity %j win', (query, expectedId) => {
    const result = search(query);
    expect(result.matches[0]?.id).toBe(expectedId);
  });

  it('asks for intent when a request contains no usable clinical signal', () => {
    for (const query of ['', 'I need a calculator']) {
      const result = search(query);
      expect(result.status, query).toBe('no_match');
      expect(result.matches, query).toEqual([]);
      expect(result.noMatchReason, query).toBe('insufficient_intent');
      expect(result.clarificationQuestion, query).toBeTruthy();
    }
  });

  it('distinguishes an unavailable calculator from an unrelated request', () => {
    const unavailable = search('PERC rule for pulmonary embolism');
    expect(unavailable).toMatchObject({
      status: 'no_match',
      matches: [],
      noMatchReason: 'not_available',
    });
    expect(unavailable.clarificationQuestion).toContain('does not currently expose');
    expect(unavailable.clarificationQuestion).toContain('Do not substitute');

    const unrelated = search('lunar orbital mechanics transfer window');
    expect(unrelated).toMatchObject({
      status: 'no_match',
      matches: [],
      noMatchReason: 'out_of_scope',
    });
  });

  it('ranks common clinical language without requiring a calculator id', () => {
    expect(search('body mass index').matches[0]?.id).toBe('bmi');
    expect(search('blood gas interpretation').matches[0]?.id).toBe('abg');

    const kidney = search('Patient kidney function from serum creatinine');
    expect(kidney.matches[0]).toMatchObject({ id: 'gfr', selection: 'candidate' });
    expect(kidney.status).toBe('matched');
  });

  it('lets a parenthetical-free declared name dominate added descriptive context', () => {
    const result = search('adult body mass index from weight and height');
    expect(result.status).toBe('matched');
    expect(result.matches).toEqual([
      expect.objectContaining({ id: 'bmi', selection: 'candidate' }),
    ]);
  });

  it('keeps an EOS request visible but blocks silent use below 35 weeks', () => {
    const result = search('Use the EOS calculator for an infant born at 34 gestational weeks');
    expect(result.status).toBe('needs_clarification');
    expect(result.matches[0]).toMatchObject({ id: 'eos', selection: 'needs_clarification' });
    expect(result.matches[0]?.matchReason).toContain('below the 35-week minimum');
    expect(result.clarificationQuestion).toContain('below 35 weeks');
  });

  it('does not silently reinterpret MELD-Na as MELD 3.0', () => {
    const result = search('Calculate MELD-Na');
    expect(result.status).toBe('needs_clarification');
    expect(result.matches[0]).toMatchObject({ id: 'meld', selection: 'needs_clarification' });
    expect(result.matches[0]?.matchReason).toContain('MELD-Na');
    expect(result.clarificationQuestion).toContain('MELD 3.0');
  });

  it('returns both BSA variants and asks for the governing variant', () => {
    for (const query of ['BSA', 'Compute body surface area from height and weight']) {
      const result = search(query);
      expect(result.status, query).toBe('needs_clarification');
      expect(result.matches, query).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'bsa', selection: 'needs_clarification' }),
        expect.objectContaining({ id: 'bsa_dubois', selection: 'needs_clarification' }),
      ]));
      expect(result.clarificationQuestion, query).toContain('body_surface_area');
    }
  });

  it.each([
    ['Estimate kidney function for a 10-year-old child', 'gfr'],
    ['Calculate eGFR during acute kidney injury', 'gfr'],
    ['Estimate GFR from creatinine during pregnancy', 'gfr'],
    ['NHS England national age-banded PEWS chart', 'pews'],
    ['Not for adults: pediatric deterioration screen', 'pews'],
    ['Mechanical heart valve stroke risk score', 'chadsvasc'],
    ['Upper extremity DVT probability score', 'wells_dvt'],
    ['A-a gradient during mechanical ventilation with PEEP', 'aa_gradient'],
    ['TIMI for undifferentiated chest pain', 'timi'],
  ])('preserves the adversarial clarification state for %j', (query, expectedId) => {
    const result = search(query);
    expect(result.matches[0], query).toMatchObject({
      id: expectedId,
      selection: 'needs_clarification',
    });
    expect(result.status, query).toBe('needs_clarification');
  });

  it('preserves typo expansion without letting exclusion prose create a result', () => {
    expect(search('glomular filtration from creatinine').matches[0]).toMatchObject({
      id: 'gfr',
      selection: 'candidate',
    });
    expect(search('PEEP').matches).toEqual([]);
    expect(search('mechanical undifferentiated').matches).toEqual([]);
  });

  it('understands a specified omission without treating every negative word as unsafe ambiguity', () => {
    expect(search('Calculate anion gap without albumin correction').matches[0]).toMatchObject({
      id: 'anion_gap',
      selection: 'candidate',
    });
  });

  it.each([
    ['BMI for a 12-year-old', 'bmi'],
    ['12yo BMI', 'bmi'],
    ['eGFR for a 17-year-old', 'gfr'],
    ['MELD for an 11-year-old', 'meld'],
  ])('blocks a named calculator outside its numeric age boundary for %j', (query, id) => {
    const result = search(query);
    expect(result.status).toBe('needs_clarification');
    expect(result.matches[0]).toMatchObject({ id, selection: 'needs_clarification' });
    expect(result.matches[0]?.matchReason).toContain('declared minimum');
  });

  it('does not mistake the Child-Pugh eponym for a pediatric population', () => {
    for (const query of ['child_pugh', 'Child Pugh', 'adult Child-Pugh', 'CTP score']) {
      const result = search(query);
      expect(result.status, query).toBe('matched');
      expect(result.matches[0], query).toMatchObject({ id: 'child_pugh', selection: 'candidate' });
    }
  });

  it('gives an explicitly named single-token calculator precedence over prose overlap', () => {
    expect(search('TIMI acute coronary syndrome mortality')).toMatchObject({
      status: 'matched',
      matches: [expect.objectContaining({ id: 'timi', selection: 'candidate' })],
    });
    const bsa = search('BSA chemotherapy dose');
    expect(bsa.matches[0]?.id).toBe('bsa');
    expect(bsa.status).toBe('needs_clarification');
  });

  it('routes stroke severity and clarifies an underspecified sepsis population', () => {
    expect(search('stroke severity')).toMatchObject({
      status: 'matched',
      matches: [expect.objectContaining({ id: 'nihss', selection: 'candidate' })],
    });

    const genericSepsis = search('sepsis score');
    expect(genericSepsis.status).toBe('needs_clarification');
    expect(genericSepsis.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'eos', selection: 'needs_clarification' }),
      expect.objectContaining({ id: 'qsofa', selection: 'needs_clarification' }),
    ]));
    expect(genericSepsis.clarificationQuestion).toContain('adult');
    expect(search('adult sepsis score').matches[0]).toMatchObject({ id: 'qsofa', selection: 'candidate' });
    expect(search('neonatal sepsis score').matches[0]).toMatchObject({ id: 'eos', selection: 'candidate' });
  });

  it('does not turn positive population language into an exclusion match', () => {
    expect(search('adult qSOFA')).toMatchObject({
      status: 'matched',
      matches: [expect.objectContaining({ id: 'qsofa', selection: 'candidate' })],
    });
    expect(search('neonatal oxygenation index')).toMatchObject({
      status: 'matched',
      matches: [expect.objectContaining({ id: 'oxygenation_index', selection: 'candidate' })],
    });
    expect(search('pediatric oxygenation index').matches[0]).toMatchObject({
      id: 'oxygenation_index', selection: 'needs_clarification',
    });
  });

  it.each([
    ['OI for a 5-year-old', 'oxygenation_index'],
    ['oxygenation index for a child', 'oxygenation_index'],
    ['EOS for a 5-year-old', 'eos'],
    ['APGAR for a 5-year-old', 'apgar'],
    ['EOS for a 6-month-old infant', 'eos'],
    ['APGAR for a 3-month-old infant', 'apgar'],
    ['oxygenation index for a 6-month-old infant', 'oxygenation_index'],
    ['OI for a 6-month-old infant', 'oxygenation_index'],
    ['EOS for a 5-year-old neonate', 'eos'],
    ['APGAR for a 5-year-old newborn', 'apgar'],
  ])('blocks neonatal-only calculator use in an older child for %j', (query, id) => {
    expect(search(query)).toMatchObject({
      status: 'needs_clarification',
      matches: [expect.objectContaining({ id, selection: 'needs_clarification' })],
    });
  });

  it.each([
    ['EOS at 34w', 'needs_clarification'],
    ['EOS GA 34', 'needs_clarification'],
    ['EOS at 34+0 weeks', 'needs_clarification'],
    ['EOS at 35+0 weeks', 'matched'],
  ] as const)('parses gestational shorthand in %j', (query, status) => {
    const result = search(query);
    expect(result.status).toBe(status);
    expect(result.matches[0]?.id).toBe('eos');
  });

  it.each([
    ['APGAR for a 1-day-old newborn', 'needs_clarification'],
    ['APGAR for a 30-minute-old newborn', 'needs_clarification'],
    ['APGAR at 25 minutes after birth', 'needs_clarification'],
    ['APGAR at 7 minutes after birth', 'needs_clarification'],
    ['APGAR at 20 minutes after birth', 'matched'],
  ] as const)('enforces the APGAR assessment-time contract for %j', (query, status) => {
    const result = search(query);
    expect(result.status).toBe(status);
    expect(result.matches[0]?.id).toBe('apgar');
  });

  it('normalizes MELDNa without silently treating it as MELD 3.0', () => {
    for (const query of ['MELDNa', 'MELD 2.0']) {
      expect(search(query)).toMatchObject({
        status: 'needs_clarification',
        matches: [expect.objectContaining({ id: 'meld', selection: 'needs_clarification' })],
      });
    }
  });

  it.each([
    ['TIMI for STEMI', 'timi'],
    ['measured GFR', 'gfr'],
    ['cystatin C eGFR', 'gfr'],
    ['MDRD eGFR', 'gfr'],
    ['GRACE in-hospital mortality', 'grace'],
  ])('blocks silent substitution of an unsupported model for %j', (query, id) => {
    expect(search(query)).toMatchObject({
      status: 'needs_clarification',
      matches: [expect.objectContaining({ id, selection: 'needs_clarification' })],
    });
  });

  it('honors an explicit qSOFA identity without adding an unrelated EOS branch', () => {
    const result = search('qSOFA as sepsis diagnosis');
    expect(result.status).toBe('needs_clarification');
    expect(result.matches.map(({ id }) => id)).toEqual(['qsofa']);
    expect(result.matches[0]?.matchReason).toContain('diagnosis');
  });

  it('clarifies the governing renal method for drug dosing', () => {
    for (const query of [
      'renal function for drug dosing',
      'kidney function for medication dosing',
      'drug label renal function',
    ]) {
      const result = search(query);
      expect(result.status, query).toBe('needs_clarification');
      expect(result.matches.map(({ id }) => id), query).toEqual(expect.arrayContaining([
        'gfr', 'creatinine_clearance',
      ]));
      expect(result.clarificationQuestion, query).toContain('kidney-function method');
    }
    expect(search('CKD-EPI renal function for drug dosing')).toMatchObject({
      status: 'matched',
      matches: [expect.objectContaining({ id: 'gfr', selection: 'candidate' })],
    });
    expect(search('CrCl for drug dosing')).toMatchObject({
      status: 'matched',
      matches: [expect.objectContaining({ id: 'creatinine_clearance', selection: 'candidate' })],
    });
  });

  it.each([
    ['CrCl', 'creatinine_clearance'],
    ['MFS', 'morse_fall_scale'],
    ['FWD', 'free_water_deficit'],
  ])('recognizes common clinical shorthand %j', (query, id) => {
    expect(search(query).matches[0]).toMatchObject({ id, selection: 'candidate' });
  });

  it('filters weak secondary matches while preserving required family variants', () => {
    expect(search('body mass index').matches.map(({ id }) => id)).toEqual(['bmi']);
    expect(search('blood gas interpretation').matches.map(({ id }) => id)).toEqual(['abg']);
    expect(search('Patient kidney function from serum creatinine').matches.map(({ id }) => id))
      .toEqual(['gfr']);
    expect(search('BSA').matches.map(({ id }) => id)).toEqual(['bsa', 'bsa_dubois']);
  });

  it('does not confuse the ordinary word map with mean arterial pressure', () => {
    expect(search('map out stroke risk in atrial fibrillation').matches[0]?.id).toBe('chadsvasc');
    expect(search('map body mass index').matches.map(({ id }) => id)).toEqual(['bmi']);
    expect(search('we need a map of calculator options').matches).toEqual([]);
    expect(search('map kidney function from serum creatinine').matches.map(({ id }) => id))
      .toEqual(['gfr']);
    expect(search('MAP').matches[0]?.id).toBe('map');
    expect(search('mean arterial pressure').matches[0]?.id).toBe('map');
  });

  it.each([
    ['height and weight', ['ibw', 'bmi']],
    ['stroke score', ['nihss', 'chadsvasc']],
    ['kidney score', ['gfr', 'kdpi']],
    ['mortality risk', ['grace']],
  ])('asks for clarification instead of silently selecting vague intent %j', (query, expectedIds) => {
    const result = search(query);
    expect(result.status, query).toBe('needs_clarification');
    expect(result.matches[0]?.selection, query).toBe('needs_clarification');
    expect(result.matches.map(({ id }) => id), query).toEqual(expect.arrayContaining(expectedIds));
    expect(result.clarificationQuestion, query).toContain('clinical quantity');
  });

  it('does not let a presentation limit erase a known ambiguity', () => {
    for (const query of ['height and weight', 'adult height and weight']) {
      const result = search(query, { limit: 1 });
      expect(result.matches).toHaveLength(1);
      expect(result.status, query).toBe('needs_clarification');
      expect(result.matches[0]?.selection, query).toBe('needs_clarification');
    }
  });

  it('returns three by default and clamps requested limits to 1..10', () => {
    const query = 'kidney function creatinine donor filtration dose';
    expect(search(query).matches.length).toBeLessThanOrEqual(3);
    expect(search(query, { limit: 0 }).matches).toHaveLength(1);
    expect(search(query, { limit: 1.9 }).matches).toHaveLength(1);
    expect(search(query, { limit: 99 }).matches.length).toBeLessThanOrEqual(10);
  });
});
