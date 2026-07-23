import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import type { BinaryOperator } from "#compiler/ir/values/binary.js";
import type { CompareOperator } from "#compiler/ir/values/comparison.js";
import type {
  IntegerWidth,
  ValueType
} from "#compiler/ir/values/types.js";
import type { ValueNode } from "#compiler/ir/values/table.js";
import type { UnaryOperator } from "#compiler/ir/values/unary.js";

type WasmValueInstruction = (body: WasmInstructionWriter) => void;
type TypedWasmValueInstruction = Readonly<
  Record<ValueType, WasmValueInstruction>
>;

const unaryInstructions = {
  popcnt: (body) => body.i32Popcnt(),
  ctz: (body) => body.i32Ctz(),
  clz: (body) => body.i32Clz(),
  eqz: (body) => body.i32Eqz()
} satisfies Readonly<Record<UnaryOperator, WasmValueInstruction>>;

const binaryInstructions = {
  add: {
    i32: (body) => body.i32Add(),
    i64: (body) => body.i64Add()
  },
  sub: {
    i32: (body) => body.i32Sub(),
    i64: (body) => body.i64Sub()
  },
  mul: {
    i32: (body) => body.i32Mul(),
    i64: (body) => body.i64Mul()
  },
  div_s: {
    i32: (body) => body.i32DivS(),
    i64: (body) => body.i64DivS()
  },
  div_u: {
    i32: (body) => body.i32DivU(),
    i64: (body) => body.i64DivU()
  },
  rem_s: {
    i32: (body) => body.i32RemS(),
    i64: (body) => body.i64RemS()
  },
  rem_u: {
    i32: (body) => body.i32RemU(),
    i64: (body) => body.i64RemU()
  },
  xor: {
    i32: (body) => body.i32Xor(),
    i64: (body) => body.i64Xor()
  },
  or: {
    i32: (body) => body.i32Or(),
    i64: (body) => body.i64Or()
  },
  and: {
    i32: (body) => body.i32And(),
    i64: (body) => body.i64And()
  },
  shl: {
    i32: (body) => body.i32Shl(),
    i64: (body) => body.i64Shl()
  },
  rotl: {
    i32: (body) => body.i32Rotl(),
    i64: (body) => body.i64Rotl()
  },
  rotr: {
    i32: (body) => body.i32Rotr(),
    i64: (body) => body.i64Rotr()
  },
  shr_s: {
    i32: (body) => body.i32ShrS(),
    i64: (body) => body.i64ShrS()
  },
  shr_u: {
    i32: (body) => body.i32ShrU(),
    i64: (body) => body.i64ShrU()
  }
} satisfies Readonly<Record<BinaryOperator, TypedWasmValueInstruction>>;

const comparisonInstructions = {
  eq: {
    i32: (body) => body.i32Eq(),
    i64: (body) => body.i64Eq()
  },
  ne: {
    i32: (body) => body.i32Ne(),
    i64: (body) => body.i64Ne()
  },
  lt_u: {
    i32: (body) => body.i32LtU(),
    i64: (body) => body.i64LtU()
  },
  le_u: {
    i32: (body) => body.i32LeU(),
    i64: (body) => body.i64LeU()
  },
  gt_u: {
    i32: (body) => body.i32GtU(),
    i64: (body) => body.i64GtU()
  },
  ge_u: {
    i32: (body) => body.i32GeU(),
    i64: (body) => body.i64GeU()
  },
  lt_s: {
    i32: (body) => body.i32LtS(),
    i64: (body) => body.i64LtS()
  },
  le_s: {
    i32: (body) => body.i32LeS(),
    i64: (body) => body.i64LeS()
  },
  gt_s: {
    i32: (body) => body.i32GtS(),
    i64: (body) => body.i64GtS()
  },
  ge_s: {
    i32: (body) => body.i32GeS(),
    i64: (body) => body.i64GeS()
  }
} satisfies Readonly<Record<CompareOperator, TypedWasmValueInstruction>>;

export function emitValueNode(
  body: WasmInstructionWriter,
  node: Exclude<ValueNode, { kind: "nodeOutput" | "loopInput" }>
): void {
  switch (node.kind) {
    case "const":
      body.i32Const(node.value);
      return;
    case "const64":
      body.i64Const(node.value);
      return;
    case "unreachable":
      body.unreachable();
      return;
    case "parameter":
      body.localGet(node.index);
      return;
    case "unary":
      emitUnaryInstruction(body, node.operator);
      return;
    case "binary":
      emitBinaryInstruction(body, node.type, node.operator);
      return;
    case "compare":
      emitComparisonInstruction(body, node.type, node.operator);
      return;
    case "extend":
      emitExtensionInstruction(
        body,
        node.resultType,
        node.width,
        node.signed
      );
      return;
    case "select":
      body.select();
      return;
    case "truncate":
      emitTruncationInstruction(body, node.inputType, node.width);
      return;
  }
}

function emitUnaryInstruction(
  body: WasmInstructionWriter,
  operator: UnaryOperator
): void {
  unaryInstructions[operator](body);
}

function emitBinaryInstruction(
  body: WasmInstructionWriter,
  type: ValueType,
  operator: BinaryOperator
): void {
  binaryInstructions[operator][type](body);
}

function emitComparisonInstruction(
  body: WasmInstructionWriter,
  type: ValueType,
  operator: CompareOperator
): void {
  comparisonInstructions[operator][type](body);
}

function emitExtensionInstruction(
  body: WasmInstructionWriter,
  resultType: ValueType,
  width: IntegerWidth,
  signed: boolean
): void {
  if (signed) {
    emitSignedWidth(body, width);
  } else {
    emitUnsignedWidth(body, width);
  }

  if (resultType !== "i64") {
    return;
  }
  if (signed) {
    body.i64ExtendI32S();
  } else {
    body.i64ExtendI32U();
  }
}

function emitTruncationInstruction(
  body: WasmInstructionWriter,
  inputType: ValueType,
  width: IntegerWidth
): void {
  if (inputType === "i64") {
    body.i32WrapI64();
  }
  emitUnsignedWidth(body, width);
}

// These emitters consume the i32 already on the Wasm stack.
function emitUnsignedWidth(
  body: WasmInstructionWriter,
  width: IntegerWidth
): void {
  switch (width) {
    case 32:
      return;
    case 16:
      body.i32Const(0xffff);
      body.i32And();
      return;
    case 8:
      body.i32Const(0xff);
      body.i32And();
      return;
  }
}

function emitSignedWidth(
  body: WasmInstructionWriter,
  width: IntegerWidth
): void {
  switch (width) {
    case 32:
      return;
    case 16:
      body.i32Extend16S();
      return;
    case 8:
      body.i32Extend8S();
      return;
  }
}
