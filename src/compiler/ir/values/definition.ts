import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { OperandWidth } from "#core/types.js";
import type { ExternalValueId } from "#ir/operands.js";
import type {
  ValueId,
  ValueInput,
  ValueType,
  WidthBounds
} from "./types.js";

export type ValueNodeBase = Readonly<{ kind: string }>;
export type ValueCaptureMode = "reemit" | "producer" | "compute" | "unreachable";
export type ValueKey = string | number | bigint | boolean;

export type ValueBoundsContext = Readonly<{
  constValue(id: ValueId): number | undefined;
  widthBounds(id: ValueId): WidthBounds;
}>;

export type ValueTrapContext = Readonly<{
  integerValue(id: ValueId): bigint | undefined;
}>;

type ValueExtension = Readonly<{
  resultType: ValueType;
  width: OperandWidth;
  value: ValueId;
}>;

export type ValueFoldContext = ValueBoundsContext & ValueTrapContext & Readonly<{
  constant(value: number): ValueId;
  unreachable(type: ValueType): ValueId;
  extension(id: ValueId): ValueExtension | undefined;
  truncate(width: OperandWidth, value: ValueId): ValueId;
  eqz(value: ValueId): ValueId;
}>;

// Definitions emit only the value's own instruction or leaf realization.
// Operand evaluation is owned by the table from the stored `inputs` list.
export type ValueEmitTarget = Readonly<{
  body: WasmFunctionBodyEncoder;
  emitActionOutput(id: ValueId): void;
  emitExternal(external: ExternalValueId): void;
  emitLoopInput(id: ValueId): void;
}>;

export type ValueEmitContext = ValueEmitTarget & Readonly<{
  emitUse(id: ValueId): void;
}>;

// A definition owns one normalized node kind. Optional hooks mean the form has
// no special behavior; StoredValueEntry supplies their common defaults.
export type ValueDefinition<Args, Node extends ValueNodeBase> = Readonly<{
  create(args: Args): Node;
  // Undefined deliberately disables interning for occurrence-identity leaves.
  internKey(node: Node): readonly ValueKey[] | undefined;
  inputs?(node: Node): readonly ValueInput[];
  resultType(node: Node): ValueType;
  widthBounds(node: Node, context: ValueBoundsContext): WidthBounds;
  fold?(node: Node, context: ValueFoldContext): ValueId | undefined;
  mayTrap?(node: Node, context: ValueTrapContext): boolean;
  captureMode: ValueCaptureMode;
  constValue?(node: Node): number | undefined;
  integerValue?(node: Node): bigint | undefined;
  emit(id: ValueId, node: Node, target: ValueEmitTarget): void;
}>;
