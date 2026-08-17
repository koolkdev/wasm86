import type { StorageWidth } from "#compiler/function/resource.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { BodyEvent } from "#compiler/wasm/function/body.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmInstructionWriter } from "#wasm/encoder/instruction-writer.js";
import type { WasmMemoryImmediate } from "#wasm/encoder/memory.js";
import type { WasmFunctionBindings } from "./bindings.js";

type WasmOperationEvent = Extract<
  BodyEvent,
  { kind: "load" | "store" | "variableRead" | "variableWrite" | "call" }
>;

type OperationValueEmitter = Readonly<{
  emitUse: (value: WasmValueId) => void;
  variableLocal: (variable: VariableRef) => number;
}>;

type LoadExtension = "signed" | "unsigned";

export function emitWasmOperation(
  body: WasmInstructionWriter,
  bindings: WasmFunctionBindings,
  values: OperationValueEmitter,
  event: WasmOperationEvent,
  loadExtension: LoadExtension = "unsigned"
): void {
  switch (event.kind) {
    case "load":
      values.emitUse(event.address);
      emitMemoryLoad(body, bindings, event, loadExtension);
      return;
    case "store":
      values.emitUse(event.address);
      values.emitUse(event.value);
      emitMemoryStore(body, bindings, event);
      return;
    case "variableRead":
      body.write(wasmInstruction.local.get, values.variableLocal(event.variable));
      return;
    case "variableWrite":
      values.emitUse(event.value);
      body.write(wasmInstruction.local.set, values.variableLocal(event.variable));
      return;
    case "call":
      for (const operand of event.operands) {
        values.emitUse(operand);
      }
      body.write(wasmInstruction.call.direct, bindings.functionIndex(event.target.ref));
      return;
  }
}

function emitMemoryLoad(
  body: WasmInstructionWriter,
  bindings: WasmFunctionBindings,
  event: Extract<BodyEvent, { kind: "load" }>,
  extension: LoadExtension
): void {
  const immediate = memoryImmediate(
    bindings.memoryIndex(event.effect.resource),
    event.storageWidth,
    event.displacement
  );

  switch (event.storageWidth) {
    case 8:
      body.write(
        extension === "signed" ? wasmInstruction.i32.load8S : wasmInstruction.i32.load8U,
        immediate
      );
      return;
    case 16:
      body.write(
        extension === "signed" ? wasmInstruction.i32.load16S : wasmInstruction.i32.load16U,
        immediate
      );
      return;
    case 32:
      body.write(wasmInstruction.i32.load, immediate);
      return;
    case 64:
      body.write(wasmInstruction.i64.load, immediate);
      return;
  }
}

function emitMemoryStore(
  body: WasmInstructionWriter,
  bindings: WasmFunctionBindings,
  event: Extract<BodyEvent, { kind: "store" }>
): void {
  const immediate = memoryImmediate(
    bindings.memoryIndex(event.effect.resource),
    event.storageWidth,
    event.displacement
  );

  switch (event.storageWidth) {
    case 8:
      body.write(wasmInstruction.i32.store8, immediate);
      return;
    case 16:
      body.write(wasmInstruction.i32.store16, immediate);
      return;
    case 32:
      body.write(wasmInstruction.i32.store, immediate);
      return;
    case 64:
      body.write(wasmInstruction.i64.store, immediate);
      return;
  }
}

function memoryImmediate(
  memoryIndex: number,
  width: StorageWidth,
  displacement: number
): WasmMemoryImmediate {
  return {
    align: naturalAlignment[width],
    offset: displacement,
    memoryIndex
  };
}

const naturalAlignment: Readonly<Record<StorageWidth, number>> = {
  8: 0,
  16: 1,
  32: 2,
  64: 3
};
