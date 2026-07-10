import { assert } from "#common/assert.js";
import type {
  BinaryValueNode,
  CompareValueNode,
  ExtendValueNode,
  TruncateValueNode,
  UnaryValueNode,
  ValueType
} from "#ir/values.js";
import type { OperandWidth } from "#x86/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmValueType, type WasmValueType } from "#wasm/encoder/types.js";

// Leaf opcode mappers: each emits the operator of a compound value node
// whose operands are already on the stack. Stateless encoder switches —
// operand pushes and use counts live in the value emitter.

export function wasmTypeForValue(type: ValueType): WasmValueType {
  switch (type) {
    case "i32":
      return wasmValueType.i32;
    case "i64":
      return wasmValueType.i64;
  }
}

export function emitBinaryOperator(body: WasmFunctionBodyEncoder, node: BinaryValueNode): void {
  if (node.type === "i64") {
    switch (node.operator) {
      case "mul":
        body.i64Mul();
        return;
      case "div_s":
        body.i64DivS();
        return;
      case "div_u":
        body.i64DivU();
        return;
      case "rem_s":
        body.i64RemS();
        return;
      case "rem_u":
        body.i64RemU();
        return;
      case "or":
        body.i64Or();
        return;
      case "shl":
        body.i64Shl();
        return;
      case "shr_s":
        body.i64ShrS();
        return;
      case "shr_u":
        body.i64ShrU();
        return;
    }

    assert(false, `unsupported i64 binary operator ${node.operator}`);
  }

  switch (node.operator) {
    case "add":
      body.i32Add();
      return;
    case "sub":
      body.i32Sub();
      return;
    case "mul":
      body.i32Mul();
      return;
    case "div_s":
      body.i32DivS();
      return;
    case "div_u":
      body.i32DivU();
      return;
    case "rem_s":
      body.i32RemS();
      return;
    case "rem_u":
      body.i32RemU();
      return;
    case "xor":
      body.i32Xor();
      return;
    case "or":
      body.i32Or();
      return;
    case "and":
      body.i32And();
      return;
    case "shl":
      body.i32Shl();
      return;
    case "rotl":
      body.i32Rotl();
      return;
    case "rotr":
      body.i32Rotr();
      return;
    case "shr_s":
      body.i32ShrS();
      return;
    case "shr_u":
      body.i32ShrU();
      return;
  }
}

export function emitUnaryOperator(body: WasmFunctionBodyEncoder, node: UnaryValueNode): void {
  switch (node.operator) {
    case "ctz":
      body.i32Ctz();
      return;
    case "clz":
      body.i32Clz();
      return;
    case "popcnt":
      body.i32Popcnt();
      return;
  }
}

export function emitCompareOperator(body: WasmFunctionBodyEncoder, node: CompareValueNode): void {
  if (node.type === "i64") {
    switch (node.operator) {
      case "eq":
        body.i64Eq();
        return;
      case "ne":
        body.i64Ne();
        return;
    }

    assert(false, `unsupported i64 compare operator ${node.operator}`);
  }

  switch (node.operator) {
    case "eq":
      body.i32Eq();
      return;
    case "ne":
      body.i32Ne();
      return;
    case "lt_u":
      body.i32LtU();
      return;
    case "le_u":
      body.i32LeU();
      return;
    case "gt_u":
      body.i32GtU();
      return;
    case "ge_u":
      body.i32GeU();
      return;
    case "lt_s":
      body.i32LtS();
      return;
    case "le_s":
      body.i32LeS();
      return;
    case "gt_s":
      body.i32GtS();
      return;
    case "ge_s":
      body.i32GeS();
      return;
  }
}

export function emitExtend(body: WasmFunctionBodyEncoder, node: ExtendValueNode): void {
  if (!node.signed) {
    emitTruncateFromI32(body, node.width);

    if (node.type === "i64") {
      body.i64ExtendI32U();
    }

    return;
  }

  switch (node.width) {
    case 8:
      body.i32Extend8S();
      break;
    case 16:
      body.i32Extend16S();
      break;
    case 32:
      break;
  }

  if (node.type === "i64") {
    body.i64ExtendI32S();
  }
}

export function emitTruncate(body: WasmFunctionBodyEncoder, node: TruncateValueNode): void {
  if (node.sourceType === "i64") {
    body.i32WrapI64();
  }

  emitTruncateFromI32(body, node.width);
}

function emitTruncateFromI32(body: WasmFunctionBodyEncoder, width: OperandWidth): void {
  switch (width) {
    case 32:
      // A full-width truncation is the value itself.
      return;
    case 16:
      body.i32Const(0xffff).i32And();
      return;
    case 8:
      body.i32Const(0xff).i32And();
      return;
  }
}
