import { assert } from "#common/assert.js";
import type { ValueType } from "#compiler/ir/values/types.js";

declare const functionTypeBrand: unique symbol;

// An owner-defined semantic contract. Program signatures pair a local
// identity with this contract; physical Wasm types may still be coalesced.
export type FunctionType = Readonly<{
  [functionTypeBrand]: true;
  parameters: readonly ValueType[];
  results: readonly ValueType[];
}>;

export function functionType(
  parameters: readonly ValueType[],
  results: readonly ValueType[]
): FunctionType {
  for (const type of [...parameters, ...results]) {
    assert(type === "i32" || type === "i64", `unknown function value type: ${String(type)}`);
  }

  return {
    parameters: [...parameters],
    results: [...results]
  } as unknown as FunctionType;
}
