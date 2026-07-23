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
      body.localGet(values.variableLocal(operation.variable));
      return;
    case "variable.write":
      body.localSet(values.variableLocal(operation.variable));
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
        ? body.i32Load8S(immediate)
        : body.i32Load8U(immediate);
      return;
    case 16:
      operation.signed
        ? body.i32Load16S(immediate)
        : body.i32Load16U(immediate);
      return;
    case 32:
      body.i32Load(immediate);
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
      body.i32Store8(immediate);
      return;
    case 16:
      body.i32Store16(immediate);
      return;
    case 32:
      body.i32Store(immediate);
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
      body.callFunction(bindings.functionIndex(target.ref));
      return;
    case "indirect":
      body.callIndirect(
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
