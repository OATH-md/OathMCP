import { describe, expect, it } from 'vitest';
import { InputError, run } from '../../src/engine/index.js';

function values(id: string, inputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(run(id, inputs).results.map((entry) => [entry.name, entry.value]));
}

describe('interpreter and conditional clinical references', () => {
  it('keeps ABG compensation arterial-only and makes ratio availability explicit', () => {
    const appropriate = values('abg', {
      ph: 7.3, paco2: 30, bicarbonate: 16, sodium: 142, chloride: 104,
      albumin: 3, sample_type: 'arterial',
    });
    expect(appropriate).toMatchObject({
      acid_base_branch_id: 'metabolic_acidemia',
      expected_paco2_range: { low: 30, mean: 32, high: 34 },
      compensation_status: 'within_expected_range',
      delta_ratio: 1.25,
      albumin_corrected_delta_ratio: 1.56,
    });

    const excessive = values('abg', {
      ph: 7.25, paco2: 20, bicarbonate: 12, sodium: 140, chloride: 100,
      sample_type: 'arterial',
    });
    expect(excessive.compensation_status).toBe('below_expected_range');
    expect(excessive.mixed_disorder_branch_ids).toContain('metabolic_acidemia_plus_respiratory_alkalemia');

    const acidemiaAbove = values('abg', {
      ph: 7.25, paco2: 40, bicarbonate: 12, sodium: 140, chloride: 100,
      sample_type: 'arterial',
    });
    expect(acidemiaAbove.compensation_status).toBe('above_expected_range');
    expect(acidemiaAbove.mixed_disorder_branch_ids).toEqual(['metabolic_acidemia_plus_respiratory_acidemia']);

    const alkalemiaBelow = values('abg', {
      ph: 7.5, paco2: 38, bicarbonate: 34, sodium: 140, chloride: 95,
      sample_type: 'arterial',
    });
    expect(alkalemiaBelow.compensation_status).toBe('below_expected_range');
    expect(alkalemiaBelow.mixed_disorder_branch_ids).toEqual(['metabolic_alkalemia_plus_respiratory_alkalemia']);

    const alkalemiaAbove = values('abg', {
      ph: 7.5, paco2: 55, bicarbonate: 34, sodium: 140, chloride: 95,
      sample_type: 'arterial',
    });
    expect(alkalemiaAbove.compensation_status).toBe('above_expected_range');
    expect(alkalemiaAbove.mixed_disorder_branch_ids).toEqual(['metabolic_alkalemia_plus_respiratory_acidemia']);

    const venous = values('abg', {
      ph: 7.28, paco2: 38, bicarbonate: 15, sodium: 140, chloride: 100,
      sample_type: 'peripheral_venous',
    });
    expect(venous).toMatchObject({
      acid_base_branch_id: 'screening_only_venous',
      compensation_basis: 'venous_pco2_not_interchangeable',
    });
    expect(venous).not.toHaveProperty('expected_paco2_range');
    expect(venous).not.toHaveProperty('compensation_status');

    const normal = values('abg', {
      ph: 7.4, paco2: 40, bicarbonate: 24, sodium: 140, chloride: 104,
    });
    expect(normal).not.toHaveProperty('delta_ratio');
    expect(normal.albumin_provenance).toBe('defaulted_4_g_dl');

    const branches = [
      [{ ph: 7.4, paco2: 40, bicarbonate: 24 }, 'within_arterial_reference'],
      [{ ph: 7.3, paco2: 30, bicarbonate: 16 }, 'metabolic_acidemia'],
      [{ ph: 7.3, paco2: 55, bicarbonate: 24 }, 'respiratory_acidemia'],
      [{ ph: 7.3, paco2: 55, bicarbonate: 16 }, 'mixed_acidemia'],
      [{ ph: 7.5, paco2: 45, bicarbonate: 34 }, 'metabolic_alkalemia'],
      [{ ph: 7.5, paco2: 25, bicarbonate: 24 }, 'respiratory_alkalemia'],
      [{ ph: 7.5, paco2: 25, bicarbonate: 34 }, 'mixed_alkalemia'],
      [{ ph: 7.4, paco2: 30, bicarbonate: 20 }, 'compensated_or_mixed_low_values'],
      [{ ph: 7.4, paco2: 50, bicarbonate: 30 }, 'compensated_or_mixed_high_values'],
      [{ ph: 7.4, paco2: 40, bicarbonate: 28 }, 'indeterminate_arterial_pattern'],
    ] as const;
    for (const [bloodGas, expectedBranch] of branches) {
      expect(values('abg', { ...bloodGas, sodium: 140, chloride: 104 }).acid_base_branch_id).toBe(expectedBranch);
    }
    expect(values('abg', {
      ph: 7.3, paco2: 55, bicarbonate: 16, sodium: 140, chloride: 104,
    }).mixed_disorder_branch_ids).toEqual(['low_bicarbonate_plus_high_pco2_acidemia']);
    expect(values('abg', {
      ph: 7.5, paco2: 25, bicarbonate: 34, sodium: 140, chloride: 104,
    }).mixed_disorder_branch_ids).toEqual(['high_bicarbonate_plus_low_pco2_alkalemia']);
    expect(values('abg', {
      ph: 7.3, paco2: 55, bicarbonate: 24, sodium: 140, chloride: 104,
    })).toMatchObject({
      compensation_basis: 'respiratory_compensation_not_evaluated',
      limitations: expect.arrayContaining(['respiratory_compensation_is_not_evaluated_by_this_tool']),
    });
  });

  it('returns CSF derivations, identified assays, compatible patterns, and limitations without diagnosis/confidence', () => {
    const result = values('csf', {
      age_years: 45,
      wbc_per_ul: 200,
      wbc_diff: 'pmn',
      rbc_per_ul: 5000,
      traumatic_tap_method: 'one_wbc_per_1000_rbc',
      csf_glucose_mmol_l: 1.5,
      serum_glucose_mmol_l: 5,
      protein_mg_dl: 80,
      gram_stain_result: 'negative',
      bacterial_culture_result: 'negative',
      pathogen_pcr_result: 'positive',
      pathogen_pcr_identity: 'bacterial_panel',
      antimicrobial_pretreatment: 'yes',
      immune_status: 'unknown',
      imaging_context: 'not_done',
    });
    expect(result.corrected_wbc).toBe(195);
    expect(result.csf_serum_glucose_ratio).toBe(0.3);
    expect(result.confirmed_assays).toContain('pathogen_pcr_positive:bacterial_panel');
    expect(result.support_flags).toContain('bacterial_meningitis_compatible_pattern');
    expect(result.limitations).toEqual(expect.arrayContaining([
      'antimicrobial_pretreatment_can_reduce_test_sensitivity',
      'traumatic_tap_correction_is_a_heuristic_with_sensitivity_specificity_tradeoffs',
    ]));
    expect(result).not.toHaveProperty('classification');
    expect(result).not.toHaveProperty('confidence');
  });

  it('distinguishes CSF method, timing, paired OCB, antibody, and correction-factor contexts', () => {
    for (const [method, expected] of [
      ['one_wbc_per_500_rbc', 30],
      ['one_wbc_per_1000_rbc', 40],
      ['one_wbc_per_1500_rbc', 44],
    ] as const) {
      expect(values('csf', {
        age_years: 40, wbc_per_ul: 50, wbc_diff: 'mixed', rbc_per_ul: 10000,
        traumatic_tap_method: method, antimicrobial_pretreatment: 'no',
        immune_status: 'immunocompetent', imaging_context: 'normal_or_no_explanation',
      }).corrected_wbc).toBe(expected);
    }

    const supported = values('csf', {
      age_years: 40, wbc_per_ul: 10, wbc_diff: 'lymphocyte', appearance: 'xanthochromic',
      xanthochromia_result: 'positive', xanthochromia_method: 'spectrophotometry', hours_from_onset_to_lumbar_puncture: 12,
      oligoclonal_band_status: 'csf_restricted', neural_antibody_result: 'positive',
      neural_antibody_identity: 'nmda_receptor', neural_antibody_specimen: 'paired',
      antimicrobial_pretreatment: 'no', immune_status: 'immunocompetent',
      imaging_context: 'normal_or_no_explanation',
    });
    expect(supported.xanthochromia_context).toBe('supported_spectrophotometry_after_12h');
    expect(supported.confirmed_assays).toEqual(expect.arrayContaining([
      'paired_ocb_csf_restricted',
      'neural_antibody_positive:nmda_receptor:paired',
    ]));

    const visual = values('csf', {
      age_years: 40, wbc_per_ul: 10, wbc_diff: 'mixed', appearance: 'xanthochromic',
      xanthochromia_result: 'positive', xanthochromia_method: 'visual', hours_from_onset_to_lumbar_puncture: 24,
      antimicrobial_pretreatment: 'no', immune_status: 'immunocompetent', imaging_context: 'not_done',
    });
    expect(visual.xanthochromia_context).toBe('result_or_method_or_timing_insufficient');
    expect(values('csf', {
      age_years: 40, wbc_per_ul: 10, wbc_diff: 'mixed', xanthochromia_result: 'negative',
      xanthochromia_method: 'spectrophotometry', hours_from_onset_to_lumbar_puncture: 12,
      antimicrobial_pretreatment: 'no',
      immune_status: 'immunocompetent', imaging_context: 'not_done',
    }).xanthochromia_context).toBe('negative_spectrophotometry_reported');
    expect(values('csf', {
      age_years: 40, wbc_per_ul: 10, wbc_diff: 'mixed', xanthochromia_result: 'negative',
      antimicrobial_pretreatment: 'no', immune_status: 'immunocompetent', imaging_context: 'not_done',
    })).toMatchObject({
      xanthochromia_context: 'result_or_method_or_timing_insufficient',
      missing_context: expect.arrayContaining(['spectrophotometric_xanthochromia_method']),
    });
    expect(values('csf', {
      age_years: 40, wbc_per_ul: 10, wbc_diff: 'mixed', xanthochromia_result: 'negative',
      xanthochromia_method: 'spectrophotometry', hours_from_onset_to_lumbar_puncture: 11.9,
      antimicrobial_pretreatment: 'no', immune_status: 'immunocompetent', imaging_context: 'not_done',
    }).xanthochromia_context).toBe('result_or_method_or_timing_insufficient');

    const unidentified = values('csf', {
      age_years: 40, wbc_per_ul: 10, wbc_diff: 'mixed',
      pathogen_pcr_result: 'positive', pathogen_pcr_identity: 'not_specified',
      mycobacterial_result: 'positive', mycobacterial_assay: 'other',
      fungal_result: 'positive', fungal_assay: 'not_specified',
      neural_antibody_result: 'positive', neural_antibody_identity: 'other', neural_antibody_specimen: 'not_specified',
      antimicrobial_pretreatment: 'unknown', immune_status: 'immunocompromised', imaging_context: 'unknown',
    });
    expect(unidentified.confirmed_assays).toEqual([]);
    expect(unidentified.support_flags).not.toContain('identified_neural_antibody_reported');
    expect(unidentified.missing_context).toEqual(expect.arrayContaining([
      'exact_pathogen_pcr_identity',
      'exact_mycobacterial_assay_identity',
      'exact_fungal_assay_identity',
      'exact_neural_antibody_identity_and_specimen',
    ]));
  });

  it('maps every explicit hepatitis triple-panel state without collapsing unknown or not tested', () => {
    const markerStates = ['positive', 'negative', 'unknown', 'not_tested'] as const;
    const absent = (state: typeof markerStates[number]) => state === 'unknown' || state === 'not_tested';
    const expectedPattern = (
      hbsag: typeof markerStates[number],
      antiHbc: typeof markerStates[number],
      antiHbs: typeof markerStates[number],
      igm: typeof markerStates[number],
    ): [string, string] => {
      if ((igm === 'positive' && antiHbc === 'negative') || (hbsag === 'positive' && antiHbs === 'positive')) {
        return ['atypical_or_contradictory_pattern', 'contradictory_or_atypical'];
      }
      if ([hbsag, antiHbc, antiHbs].some(absent)) return ['incomplete_triple_panel', 'insufficient'];
      if (hbsag === 'positive' && antiHbc === 'positive' && antiHbs === 'negative') {
        if (igm === 'positive') return ['acute_infection_pattern', 'complete_supported'];
        if (igm === 'negative') return ['chronic_infection_pattern', 'complete_supported'];
        return ['incomplete_triple_panel', 'insufficient'];
      }
      if (hbsag === 'negative' && antiHbc === 'positive' && igm === 'positive') {
        return ['resolving_or_window_pattern', 'complete_supported'];
      }
      if (hbsag === 'negative' && antiHbc === 'positive' && antiHbs === 'positive') {
        return ['resolved_infection_pattern', 'complete_supported'];
      }
      if (hbsag === 'negative' && antiHbc === 'negative' && antiHbs === 'positive') {
        return ['vaccine_immunity_pattern', 'complete_supported'];
      }
      if (hbsag === 'negative' && antiHbc === 'positive' && antiHbs === 'negative') {
        return ['isolated_core_antibody_pattern', 'complete_supported'];
      }
      if (hbsag === 'negative' && antiHbc === 'negative' && antiHbs === 'negative') {
        return ['susceptible_pattern', 'complete_supported'];
      }
      return ['atypical_or_contradictory_pattern', 'contradictory_or_atypical'];
    };
    for (const hbsag of markerStates) for (const anti_hbc of markerStates) {
      for (const anti_hbs of markerStates) for (const igm_anti_hbc of markerStates) {
        const result = values('hepb', { hbsag, anti_hbc, anti_hbs, igm_anti_hbc });
        const [statusCode, quality] = expectedPattern(hbsag, anti_hbc, anti_hbs, igm_anti_hbc);
        expect(result).toMatchObject({ status_code: statusCode, pattern_quality: quality });
      }
    }
    expect(values('hepb', {
      hbsag: 'positive', anti_hbc: 'negative', anti_hbs: 'negative', igm_anti_hbc: 'positive',
    }).pattern_quality).toBe('contradictory_or_atypical');
    expect(values('hepb', {
      hbsag: 'negative', anti_hbc: 'positive', anti_hbs: 'negative', hbeag: 'positive', anti_hbe: 'positive',
    }).replication_marker_context).toBe('both_detected');
    for (const hbeag of markerStates) for (const anti_hbe of markerStates) {
      const result = values('hepb', {
        hbsag: 'negative', anti_hbc: 'negative', anti_hbs: 'negative', hbeag, anti_hbe,
      });
      const expected = hbeag === 'positive' && anti_hbe === 'positive'
        ? 'both_detected'
        : hbeag === 'positive'
          ? 'hbeag_detected'
          : anti_hbe === 'positive'
            ? 'anti_hbe_detected'
            : absent(hbeag) || absent(anti_hbe)
              ? 'not_fully_assessed'
              : 'neither_detected';
      expect(result.replication_marker_context).toBe(expected);
      if (absent(hbeag)) expect(result.missing_context).toContain(`hbeag_${hbeag}`);
      if (absent(anti_hbe)) expect(result.missing_context).toContain(`anti_hbe_${anti_hbe}`);
    }
  });

  it('covers all seven nonempty neonatal input families and rejects no-input calls', () => {
    const fields = ['weight_grams', 'gestational_age_weeks', 'corrected_gestational_age_weeks'] as const;
    for (let mask = 1; mask < 8; mask += 1) {
      const inputs: Record<string, number> = {};
      if (mask & 1) inputs[fields[0]] = 999.5;
      if (mask & 2) {
        inputs[fields[1]] = 28;
        inputs.postnatal_age_hours = 12;
      }
      if (mask & 4) inputs[fields[2]] = 36;
      const result = values('neonatal_measurements', inputs);
      expect(result).toHaveProperty('limitations');
      expect('uac_depth_estimate_cm' in result).toBe(Boolean(mask & 1));
      expect('ett_depth_at_lip_cm' in result).toBe(Boolean(mask & 2));
      expect('corrected_map_mm_hg' in result).toBe(Boolean(mask & 4));
    }
    expect(() => run('neonatal_measurements', {})).toThrow(InputError);
    expect(values('neonatal_measurements', { gestational_age_weeks: 23 }).ett_depth_at_lip_cm).toBe(5.5);
    expect(values('neonatal_measurements', { gestational_age_weeks: 42, postnatal_age_hours: 12 }).day_one_map_mm_hg).toEqual({ low: 40, mean: 51, high: 62 });
    expect(values('neonatal_measurements', { corrected_gestational_age_weeks: 24 }).corrected_map_mm_hg).toEqual({ low: 20, mean: 36, high: 53 });
    expect(values('neonatal_measurements', { corrected_gestational_age_weeks: 46 }).corrected_map_mm_hg).toEqual({ low: 48, mean: 64, high: 78 });
    expect(values('neonatal_measurements', { gestational_age_weeks: 43 }).ett_depth_at_lip_cm).toBe(9);
    expect(values('neonatal_measurements', { gestational_age_weeks: 22 })).not.toHaveProperty('day_one_map_mm_hg');
    expect(values('neonatal_measurements', { gestational_age_weeks: 22, postnatal_age_hours: 24 })).toHaveProperty('day_one_map_mm_hg');
    expect(values('neonatal_measurements', { gestational_age_weeks: 22, postnatal_age_hours: 24.1 })).not.toHaveProperty('day_one_map_mm_hg');
    expect(values('neonatal_measurements', { gestational_age_weeks: 22, postnatal_age_hours: 12 })).toMatchObject({
      day_one_systolic_bp_mm_hg: { low: 22, mean: 39, high: 55 },
      day_one_diastolic_bp_mm_hg: { low: 14, mean: 23, high: 31 },
      day_one_map_mm_hg: { low: 17, mean: 28, high: 39 },
      day_one_pulse_pressure_mm_hg: { low: 8, mean: 12, high: 18 },
    });
    expect(values('neonatal_measurements', { corrected_gestational_age_weeks: 46 })).toMatchObject({
      corrected_systolic_bp_mm_hg: { low: 71, mean: 89, high: 102 },
      corrected_diastolic_bp_mm_hg: { low: 36, mean: 51, high: 66 },
      corrected_map_mm_hg: { low: 48, mean: 64, high: 78 },
      corrected_pulse_pressure_mm_hg: { low: 21, mean: 25, high: 33 },
    });
  });
});
