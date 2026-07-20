export interface Inputs { readonly TODO_criterion: boolean }
export interface Outputs { readonly score: number }

export function compute(inputs: Inputs): Outputs {
  return { score: inputs.TODO_criterion ? 1 : 0 };
}
