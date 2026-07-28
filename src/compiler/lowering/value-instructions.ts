import { wasmInstruction } from "#compiler/encoder/instructions.js";
import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import type { IntegerWidth, ValueType } from "#compiler/ir/values/types.js";
import type { ValueNode } from "#compiler/ir/values/table.js";

export function emitValueNode(
  body: WasmInstructionWriter,
  node: Exclude<ValueNode, { kind: "nodeOutput" | "loopInput" }>
): void {
  switch (node.kind) {
    case "const":
      body.write(wasmInstruction.i32.const, node.value);
      return;
    case "const64":
      body.write(wasmInstruction.i64.const, node.value);
      return;
    case "unreachable":
      body.write(wasmInstruction.control.unreachable);
      return;
    case "parameter":
      body.write(wasmInstruction.local.get, node.index);
      return;
    case "unary":
      body.write(wasmInstruction.i32[node.operator]);
      return;
    case "binary":
      body.write(wasmInstruction[node.type][node.operator]);
      return;
    case "compare":
      body.write(wasmInstruction[node.type][node.operator]);
      return;
    case "extend":
      emitExtensionInstruction(body, node.resultType, node.width, node.signed);
      return;
    case "select":
      body.write(wasmInstruction.parametric.select);
      return;
    case "truncate":
      emitTruncationInstruction(body, node.inputType, node.width);
      return;
  }
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
    body.write(wasmInstruction.i64.extendI32S);
  } else {
    body.write(wasmInstruction.i64.extendI32U);
  }
}

function emitTruncationInstruction(
  body: WasmInstructionWriter,
  inputType: ValueType,
  width: IntegerWidth
): void {
  if (inputType === "i64") {
    body.write(wasmInstruction.i32.wrapI64);
  }
  emitUnsignedWidth(body, width);
}

// These emitters consume the i32 already on the Wasm stack.
function emitUnsignedWidth(body: WasmInstructionWriter, width: IntegerWidth): void {
  switch (width) {
    case 32:
      return;
    case 16:
      body.write(wasmInstruction.i32.const, 0xffff);
      body.write(wasmInstruction.i32.and);
      return;
    case 8:
      body.write(wasmInstruction.i32.const, 0xff);
      body.write(wasmInstruction.i32.and);
      return;
  }
}

function emitSignedWidth(body: WasmInstructionWriter, width: IntegerWidth): void {
  switch (width) {
    case 32:
      return;
    case 16:
      body.write(wasmInstruction.i32.extend16S);
      return;
    case 8:
      body.write(wasmInstruction.i32.extend8S);
      return;
  }
}
