import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type {
  ValueId,
  ValueInput,
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

export type BorrowedOperationInput = Readonly<{ push(): void }>;

export type OperationValueEmitter = Readonly<{
  emitUse(value: ValueId): void;
  withBorrowedUse(value: ValueId, callback: (borrowed: BorrowedOperationInput) => void): void;
  constValue(value: ValueId): number | undefined;
}>;

// Definitions can realize only the operands stored on their operation. Every
// declared index must be consumed exactly once before emission returns.
export type DeclaredOperationInputs = Readonly<{
  use(index: number): void;
  withBorrowedUse(index: number, callback: (borrowed: BorrowedOperationInput) => void): void;
  // Consumes the input only when its value is statically known.
  takeConstant(index: number): number | undefined;
}>;

// Built once per emitted fragment. The two resolvers are temporary inputs to
// operations removed or reshaped by later stages; inputs are passed separately
// because their consumption state belongs to one operation emission.
export type OperationEmitTarget = Readonly<{
  body: WasmFunctionBodyEncoder;
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
