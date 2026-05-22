import {
  cleanValueWidth,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import {
  emitWasmIrLoadGuestUnchecked
} from "#backends/wasm/codegen/memory.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type {
  DefinitionEntry
} from "#backends/wasm/jit/codegen/plan/schedule-types.js";
import type { ValueEmitter } from "./values.js";

export type MemoryDefinitionEmitter = Readonly<{
  emit(definition: DefinitionEntry, values: ValueEmitter): void;
}>;

export type MemoryDefinitionEmitterInput = Readonly<{
  body: WasmFunctionBodyEncoder;
}>;

export function createMemoryDefinitionEmitter(
  input: MemoryDefinitionEmitterInput
): MemoryDefinitionEmitter {
  return {
    emit: (definition, values) => emitMemoryDefinition(input, definition, values)
  };
}

function emitMemoryDefinition(
  input: MemoryDefinitionEmitterInput,
  definition: DefinitionEntry,
  values: ValueEmitter
): void {
  switch (definition.kind) {
    case "defineLoadResult":
      emitMemoryLoadValue(input, definition, values);
      return;
  }
}

function emitMemoryLoadValue(
  input: MemoryDefinitionEmitterInput,
  definition: Extract<DefinitionEntry, { kind: "defineLoadResult" }>,
  values: ValueEmitter
): void {
  const captured = values.define(
    definition.result,
    () => {
      emitWasmIrLoadGuestUnchecked(
        input.body,
        () => {
          values.emit(definition.address, { requestedWidth: 32 });
        },
        definition.width,
        definition.signed
      );

      return signedLoadValueWidth(definition.width, definition.signed);
    }
  );

  captured?.release();
}

function signedLoadValueWidth(width: 8 | 16 | 32, signed: boolean): ValueWidth {
  if (signed && width < 32) {
    return cleanValueWidth(32);
  }

  return cleanValueWidth(width);
}
