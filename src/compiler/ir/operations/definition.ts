import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type {
  ValueId,
  ValueInput,
  ValueType,
  WidthBounds
} from "#compiler/ir/values/types.js";

export type OperationNodeBase = Readonly<{
  category: "operation";
  kind: string;
}>;

// i64 results structurally carry no i32 width bounds.
export type OperationResult =
  | Readonly<{ type: "i32"; bounds?: WidthBounds }>
  | Readonly<{ type: "i64" }>;

export function operationResult(type: ValueType): OperationResult {
  switch (type) {
    case "i32":
      return { type: "i32" };
    case "i64":
      return { type: "i64" };
  }
}

export type OperationOutputAllocator = (result: OperationResult) => ValueId;

export type OperationProduction = Readonly<{
  output: ValueId;
  result: OperationResult;
}>;

export type DerivedOperationDescription<
  Productions extends readonly OperationProduction[] =
    readonly OperationProduction[]
> = Readonly<{
  // Typed dependencies in eager evaluation order.
  inputs: readonly ValueInput[];
  productions: Productions;
  effects: StorageEffects;
  referencedResources?: readonly ResourceRef[];
}>;

// An operation definition owns both construction and the traversal facts
// derived from one semantic node kind.
export type OperationDefinition<
  CreateArgs,
  Entry extends OperationNodeBase,
  Productions extends readonly OperationProduction[]
> = Readonly<{
  kind: Entry["kind"];
  create: (
    args: CreateArgs,
    ...allocation: Productions extends readonly []
      ? [allocateOutput?: OperationOutputAllocator]
      : [allocateOutput: OperationOutputAllocator]
  ) => Entry;
  describe: (
    operation: Entry
  ) => DerivedOperationDescription<Productions>;
}>;
