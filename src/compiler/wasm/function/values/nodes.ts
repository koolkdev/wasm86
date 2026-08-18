import type {
  FloatBinaryOperator,
  FloatCompareOperator
} from "#compiler/function/values/float/types.js";
import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator
} from "#compiler/function/values/integer/operators.js";
import type { WasmIntegerType, WasmValueType } from "#wasm/types.js";

declare const wasmValueIdBrand: unique symbol;

export type WasmValueId = number & {
  readonly [wasmValueIdBrand]: "wasm";
};

export function wasmValueId(id: number): WasmValueId {
  return id as WasmValueId;
}

type WasmNode<
  Kind extends string,
  Type extends WasmValueType,
  Inputs extends readonly WasmValueId[]
> = Readonly<{
  kind: Kind;
  type: Type;
  inputs: Inputs;
}>;

// One operation vocabulary, indexed by Wasm type: each type admits its own
// operator alphabet and constant payload.
type ConstantPayloadFor = Readonly<{
  i32: Readonly<{ value: number }>;
  i64: Readonly<{ value: bigint }>;
  f32: Readonly<{ bits: number }>;
  f64: Readonly<{ bits: bigint }>;
}>;

type BinaryOperatorFor = Readonly<{
  i32: BinaryOperator;
  i64: BinaryOperator;
  f32: FloatBinaryOperator;
  f64: FloatBinaryOperator;
}>;

type CompareOperatorFor = Readonly<{
  i32: CompareOperator;
  i64: CompareOperator;
  f32: FloatCompareOperator;
  f64: FloatCompareOperator;
}>;

export type ConstantNode = {
  [Type in WasmValueType]: WasmNode<"const", Type, readonly []> & ConstantPayloadFor[Type];
}[WasmValueType];

export type UnreachableNode = WasmNode<"unreachable", WasmValueType, readonly []>;

export type ParameterNode = WasmNode<"parameter", WasmValueType, readonly []> &
  Readonly<{ index: number }>;

export type ProducerOutputNode = WasmNode<"producerOutput", WasmValueType, readonly []>;

export type LoopInputNode = WasmNode<"loopInput", WasmValueType, readonly []>;

export type I32UnaryOperator = BitCountOperator | "extend8_s" | "extend16_s";
export type I64UnaryOperator = BitCountOperator;
export type UnaryOperator = I32UnaryOperator | I64UnaryOperator;

export type UnaryNode =
  | (WasmNode<"unary", "i32", readonly [value: WasmValueId]> &
      Readonly<{ operator: I32UnaryOperator }>)
  | (WasmNode<"unary", "i64", readonly [value: WasmValueId]> &
      Readonly<{ operator: I64UnaryOperator }>);

export type BinaryNode = {
  [Type in WasmValueType]: WasmNode<"binary", Type, readonly [a: WasmValueId, b: WasmValueId]> &
    Readonly<{ operator: BinaryOperatorFor[Type] }>;
}[WasmValueType];

export type ComparisonNode = {
  [Type in WasmValueType]: WasmNode<"compare", "i32", readonly [a: WasmValueId, b: WasmValueId]> &
    Readonly<{ inputType: Type; operator: CompareOperatorFor[Type] }>;
}[WasmValueType];

// Required-bit analysis narrows binary operations to their integer forms.
export type IntegerBinaryNode = Extract<BinaryNode, { type: WasmIntegerType }>;

export type EqzNode = WasmNode<"eqz", "i32", readonly [value: WasmValueId]> &
  Readonly<{ inputType: WasmIntegerType }>;

export type ConversionOperator = "wrap_i64" | "extend_i32_s" | "extend_i32_u";

export type ConversionNode =
  | (WasmNode<"convert", "i32", readonly [value: WasmValueId]> & Readonly<{ operator: "wrap_i64" }>)
  | (WasmNode<"convert", "i64", readonly [value: WasmValueId]> &
      Readonly<{ operator: "extend_i32_s" | "extend_i32_u" }>);

export type SelectNode = WasmNode<
  "select",
  WasmValueType,
  readonly [whenTrue: WasmValueId, whenFalse: WasmValueId, condition: WasmValueId]
>;

export type WasmValueNode =
  | ConstantNode
  | UnreachableNode
  | ParameterNode
  | ProducerOutputNode
  | LoopInputNode
  | UnaryNode
  | BinaryNode
  | ComparisonNode
  | EqzNode
  | ConversionNode
  | SelectNode;

export type WasmValueSource = "inline" | "output" | "expression";

export function wasmValueSource(node: WasmValueNode): WasmValueSource {
  switch (node.kind) {
    case "const":
    case "unreachable":
    case "parameter":
    case "loopInput":
      return "inline";
    case "producerOutput":
      return "output";
    case "unary":
    case "binary":
    case "compare":
    case "eqz":
    case "convert":
    case "select":
      return "expression";
  }
}
