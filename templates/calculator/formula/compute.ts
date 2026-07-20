export interface Inputs { readonly TODO_input: number }
export interface Outputs { readonly TODO_output: number }

export function compute(inputs: Inputs): Outputs {
  return { TODO_output: inputs.TODO_input };
}
