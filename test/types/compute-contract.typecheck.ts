import { registerCompute } from '../../src/engine/registry.js';

registerCompute('bmi', (inputs) => ({ bmi: inputs.weight_kg / 10 }));

registerCompute('bmi', (inputs) => {
  // @ts-expect-error generated input contracts reject misspelled fields
  void inputs.weigth_kg;
  return { bmi: 1 };
});

// @ts-expect-error generated output contracts reject misspelled output names
registerCompute('bmi', () => ({ bmi_value: 1 }));

// @ts-expect-error generated output contracts reject wrong output value types
registerCompute('bmi', () => ({ bmi: 'normal' }));
