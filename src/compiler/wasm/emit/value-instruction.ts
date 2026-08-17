import { assert } from "#common/assert.js";
import type {
  ConversionNode,
  UnaryNode,
  WasmValueNode
} from "#compiler/wasm/function/values/nodes.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmInstructionWriter } from "#wasm/encoder/instruction-writer.js";

type EmittableValueNode = Exclude<WasmValueNode, { kind: "producerOutput" | "loopInput" }>;

export function emitWasmValueInstruction(
  body: WasmInstructionWriter,
  node: EmittableValueNode
): void {
  switch (node.kind) {
    case "const":
      switch (node.type) {
        case "i32":
          body.write(wasmInstruction.i32.const, node.value);
          return;
        case "i64":
          body.write(wasmInstruction.i64.const, node.value);
          return;
        case "f32":
          body.write(wasmInstruction.f32.const, node.bits);
          return;
        case "f64":
          body.write(wasmInstruction.f64.const, node.bits);
          return;
      }
    case "unreachable":
      body.write(wasmInstruction.control.unreachable);
      return;
    case "parameter":
      body.write(wasmInstruction.local.get, node.index);
      return;
    case "unary":
      emitUnaryInstruction(body, node);
      return;
    // Keep integer and float cases separate so each operator remains
    // correlated with its instruction table.
    case "binary":
      switch (node.type) {
        case "i32":
        case "i64": {
          const instruction = wasmInstruction[node.type][node.operator];

          assert(
            instruction !== undefined,
            `${node.type}.${node.operator} has no Wasm instruction`
          );
          body.write(instruction);
          return;
        }
        case "f32":
        case "f64": {
          const instruction = wasmInstruction[node.type][node.operator];

          assert(
            instruction !== undefined,
            `${node.type}.${node.operator} has no Wasm instruction`
          );
          body.write(instruction);
          return;
        }
      }
    case "compare":
      switch (node.inputType) {
        case "i32":
        case "i64": {
          const instruction = wasmInstruction[node.inputType][node.operator];

          assert(
            instruction !== undefined,
            `${node.inputType}.${node.operator} has no Wasm instruction`
          );
          body.write(instruction);
          return;
        }
        case "f32":
        case "f64": {
          const instruction = wasmInstruction[node.inputType][node.operator];

          assert(
            instruction !== undefined,
            `${node.inputType}.${node.operator} has no Wasm instruction`
          );
          body.write(instruction);
          return;
        }
      }
    case "eqz":
      body.write(wasmInstruction[node.inputType].eqz);
      return;
    case "convert":
      emitConversionInstruction(body, node);
      return;
    case "select":
      body.write(wasmInstruction.parametric.select);
      return;
  }
}

function emitUnaryInstruction(body: WasmInstructionWriter, node: UnaryNode): void {
  if (node.type === "i64") {
    const instruction = wasmInstruction.i64[node.operator];

    assert(instruction !== undefined, `i64.${node.operator} has no Wasm instruction`);
    body.write(instruction);
    return;
  }

  switch (node.operator) {
    case "extend8_s":
      body.write(wasmInstruction.i32.extend8S);
      return;
    case "extend16_s":
      body.write(wasmInstruction.i32.extend16S);
      return;
    case "clz":
    case "ctz":
    case "popcnt": {
      const instruction = wasmInstruction.i32[node.operator];

      assert(instruction !== undefined, `i32.${node.operator} has no Wasm instruction`);
      body.write(instruction);
      return;
    }
  }
}

function emitConversionInstruction(body: WasmInstructionWriter, node: ConversionNode): void {
  switch (node.operator) {
    case "wrap_i64":
      body.write(wasmInstruction.i32.wrapI64);
      return;
    case "extend_i32_s":
      body.write(wasmInstruction.i64.extendI32S);
      return;
    case "extend_i32_u":
      body.write(wasmInstruction.i64.extendI32U);
      return;
  }
}
