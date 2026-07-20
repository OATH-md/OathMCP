export interface Inputs { readonly TODO_input: string }
export interface Outputs { readonly TODO_output: string }

export function compute(inputs: Inputs): Outputs {
  return { TODO_output: inputs.TODO_input };
}
