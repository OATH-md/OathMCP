export interface Inputs { readonly TODO_key: string }
export interface Outputs { readonly TODO_output: number }

export function compute(inputs: Inputs): Outputs {
  throw new Error(`TODO implement immutable lookup for ${inputs.TODO_key}`);
}
