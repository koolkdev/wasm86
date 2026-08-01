import type { FunctionType } from "#compiler/wasm/legacy/function-type.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { Region } from "#compiler/ir/region.js";

export type FunctionGraph = Readonly<{
  body: Region;
  values: ValueTable;
}>;

export type Function = FunctionGraph &
  Readonly<{
    type: FunctionType;
    parameters: readonly ValueId[];
  }>;
