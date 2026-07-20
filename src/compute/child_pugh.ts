/**
 * Child-Pugh Score — severity/prognosis of chronic liver disease (cirrhosis).
 *
 * Sum of five 1-3 parameter scores (bilirubin, albumin, INR, ascites,
 * encephalopathy). Points are declared in `specs/child_pugh.yaml` and summed via
 * the shared scoring helper. The score maps to a class (A/B/C), and each class
 * carries its prognosis and survival estimates. Severity strata are declared in
 * `interpretationBands`.
 */
import { registerCompute } from '../engine/registry.js';
import { sumDeclaredScore } from './score.js';
import type { CalculatorInputsById, CalculatorOutputsById } from './types.generated.js';

type ClassInfo = Omit<CalculatorOutputsById['child_pugh'], 'score'>;

// Prognosis and survival estimates keyed by Child-Pugh class.
const CLASS_INFO: Record<'A' | 'B' | 'C', ClassInfo> = {
  A: {
    class: 'A',
    prognosis: 'Well-compensated liver disease',
  },
  B: {
    class: 'B',
    prognosis: 'Moderately impaired liver function',
  },
  C: {
    class: 'C',
    prognosis: 'Advanced hepatic dysfunction',
  },
};

function childClass(score: number): 'A' | 'B' | 'C' {
  if (score <= 6) return 'A';
  if (score <= 9) return 'B';
  return 'C';
}

function childPugh(inputs: CalculatorInputsById['child_pugh']): CalculatorOutputsById['child_pugh'] {
  const score = sumDeclaredScore('child_pugh', inputs).total as number;
  return { score, ...CLASS_INFO[childClass(score)] };
}

registerCompute('child_pugh', childPugh);
