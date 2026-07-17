import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type {
  ValueId,
  ValueInput,
  ValueType,
  WidthBounds
} from "#compiler/ir/values/types.js";
import type { CellRef } from "#compiler/refs/cell.js";
import type { ResourceRef } from "#compiler/ir/resource.js";

// i64 results structurally carry no i32 width bounds.
export type OperationResult =
  | Readonly<{ type: "i32"; bounds?: WidthBounds }>
  | Readonly<{ type: "i64" }>;

export type OperationNode<
  Kind extends string,
  Args extends object,
  Result extends OperationResult | undefined
> = Readonly<Args & {
  kind: Kind;
  // Repeated ids are repeated semantic uses and remain repeated entries.
  inputs: readonly ValueInput[];
  result: Result;
  effects: StorageEffects;
}>;

export type OperationValueEmitter = Readonly<{
  emitUse(value: ValueId): void;
  constValue(value: ValueId): number | undefined;
}>;

// Definitions can realize only the operands stored on their operation. Every
// input must be handled exactly once, either by emitting it or by folding a
// statically known constant into the instruction stream.
export type DeclaredOperationInputs = Readonly<{
  use(index: number): void;
  // Consumes the input only when its value is statically known.
  constValue(index: number): number | undefined;
}>;

// Lowering-only services shared by operation definitions. Scoped locals never
// escape one operation emission or become part of placement.
export type OperationEmitTarget = Readonly<{
  body: WasmFunctionBodyEncoder;
  withTemporaryLocal(
    type: ValueType,
    callback: (local: number) => void
  ): void;
  cellLocal(cell: CellRef): number;
  resourceIndex(resource: ResourceRef): number;
}>;

type AnyOperationNode = OperationNode<
  string,
  object,
  OperationResult | undefined
>;

export type OperationDefinition<
  CreateArgs,
  Operation extends AnyOperationNode
> = Readonly<{
  kind: Operation["kind"];
  create(args: CreateArgs): Operation;
  emit(
    operation: Operation,
    target: OperationEmitTarget,
    inputs: DeclaredOperationInputs
  ): void;
}>;
