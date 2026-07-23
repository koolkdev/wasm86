import { wasmInstruction } from "#compiler/encoder/instructions.js";
import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import type { WasmMemoryImmediate } from "#compiler/encoder/memory.js";
import type { CallTarget } from "#compiler/ir/invocation.js";
import type {
  Operation,
  ResourceReadOperation,
  ResourceWriteOperation
} from "#compiler/ir/operations/index.js";
import type { IntegerWidth } from "#compiler/ir/values/types.js";
import type { ModuleBindings } from "#compiler/module/bindings.js";
import type { ValueEmitter } from "./values.js";

export function emitOperation(
  body: WasmInstructionWriter,
  bindings: ModuleBindings,
  values: ValueEmitter,
  operation: Operation
): void {
  for (const input of operation.inputs) {
    values.emitUse(input.value);
  }

  switch (operation.kind) {
    case "call":
      emitCall(body, bindings, operation.invocation.target);
      return;
    case "variable.read":
      body.write(
        wasmInstruction.local.get,
        values.variableLocal(operation.variable)
      );
      return;
    case "variable.write":
      body.write(
        wasmInstruction.local.set,
        values.variableLocal(operation.variable)
      );
      return;
    case "resource.read":
      emitResourceRead(body, bindings, operation);
      return;
    case "resource.write":
      emitResourceWrite(body, bindings, operation);
      return;
  }
}

function emitResourceRead(
  body: WasmInstructionWriter,
  bindings: ModuleBindings,
  operation: ResourceReadOperation
): void {
  const immediate = resourceImmediate(
    bindings.resourceIndex(operation.effect.resource),
    operation.width,
    operation.displacement
  );

  switch (operation.width) {
    case 8:
      operation.signed
        ? body.write(wasmInstruction.i32.load8S, immediate)
        : body.write(wasmInstruction.i32.load8U, immediate);
      return;
    case 16:
      operation.signed
        ? body.write(wasmInstruction.i32.load16S, immediate)
        : body.write(wasmInstruction.i32.load16U, immediate);
      return;
    case 32:
      body.write(wasmInstruction.i32.load, immediate);
      return;
  }
}

function emitResourceWrite(
  body: WasmInstructionWriter,
  bindings: ModuleBindings,
  operation: ResourceWriteOperation
): void {
  const immediate = resourceImmediate(
    bindings.resourceIndex(operation.effect.resource),
    operation.width,
    operation.displacement
  );

  switch (operation.width) {
    case 8:
      body.write(wasmInstruction.i32.store8, immediate);
      return;
    case 16:
      body.write(wasmInstruction.i32.store16, immediate);
      return;
    case 32:
      body.write(wasmInstruction.i32.store, immediate);
      return;
  }
}

function emitCall(
  body: WasmInstructionWriter,
  bindings: ModuleBindings,
  target: CallTarget
): void {
  switch (target.kind) {
    case "direct":
      body.write(
        wasmInstruction.call.direct,
        bindings.functionIndex(target.ref)
      );
      return;
    case "indirect":
      body.write(
        wasmInstruction.call.indirect,
        bindings.typeIndex(target.type),
        bindings.tableIndex(target.table)
      );
      return;
  }
}

function resourceImmediate(
  memoryIndex: number,
  width: IntegerWidth,
  displacement: number
): WasmMemoryImmediate {
  return {
    align: naturalAlignment[width],
    offset: displacement,
    memoryIndex
  };
}

const naturalAlignment: Readonly<Record<IntegerWidth, number>> = {
  8: 0,
  16: 1,
  32: 2
};
