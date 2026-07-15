import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type {
  ValueId,
  ValueInput,
  ValueType,
  WidthBounds
} from "#compiler/ir/values/types.js";
import type { X86StatusFlag } from "#core/flags/definitions.js";
import type { StateSlot } from "#ir/slots.js";

export type StorageAccess =
  | Readonly<{ space: "state"; slot: StateSlot }>
  | Readonly<{ space: "memory" }>
  | Readonly<{ space: "memoryBounds" }>
  | Readonly<{ space: "var"; variable: number }>;

export type OperationEffects = Readonly<{
  reads: readonly StorageAccess[];
  writes: readonly StorageAccess[];
}>;

export type HelperCall = Readonly<{
  kind: "lazyFlag";
  flag: X86StatusFlag;
}>;

export type OperationResult = Readonly<{
  type: "i32";
  bounds?: WidthBounds;
}>;

export type OperationNode<
  Kind extends string,
  Args extends object,
  Result extends OperationResult | undefined
> = Readonly<Args & {
  kind: Kind;
  // Repeated ids are repeated semantic uses and remain repeated entries.
  inputs: readonly ValueInput[];
  result: Result;
  effects: OperationEffects;
  helper?: HelperCall;
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
  variableLocal(variable: number): number;
  helperFunctionIndex(helper: HelperCall): number;
}>;

export type OperationDefinition<
  Kind extends string,
  Args extends object,
  Result extends OperationResult | undefined
> = Readonly<{
  kind: Kind;
  create(args: Args): OperationNode<Kind, Args, Result>;
  emit(
    operation: OperationNode<Kind, Args, Result>,
    target: OperationEmitTarget,
    inputs: DeclaredOperationInputs
  ): void;
}>;
