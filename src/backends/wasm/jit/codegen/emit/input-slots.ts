import { stateOffset } from "#wasm/abi.js";
import {
  emitLoadStateS8,
  emitLoadStateS16,
  emitLoadStateU8,
  emitLoadStateU16,
  emitLoadStateU32
} from "#wasm/codegen/state.js";
import { cleanValueWidth, type ValueWidth } from "#wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { JitArchitecturalSlot } from "#backends/wasm/jit/ir/values/types.js";
import {
  jitRegisterSlotAlias
} from "#backends/wasm/jit/ir/values/slots.js";
import type { OperandWidth } from "#x86/types.js";
import type { InputEmitter } from "./values.js";

export function createInputSlotEmitter(body: WasmFunctionBodyEncoder): InputEmitter {
  return {
    emit: (slot) => emitInputSlot(body, slot),
    emitBits: (slot, bitOffset, width, signed) =>
      emitInputSlotBits(body, slot, bitOffset, width, signed)
  };
}

export function emitInputSlot(body: WasmFunctionBodyEncoder, slot: JitArchitecturalSlot): ValueWidth {
  switch (slot.kind) {
    case "reg32":
      emitLoadStateU32(body, stateOffset[slot.reg]);
      return cleanValueWidth(32);
    case "reg16": {
      const alias = jitRegisterSlotAlias(slot);

      emitLoadStateU16(body, stateOffset[alias.base] + alias.bitOffset / 8);
      return cleanValueWidth(16);
    }
    case "reg8": {
      const alias = jitRegisterSlotAlias(slot);

      emitLoadStateU8(body, stateOffset[alias.base] + alias.bitOffset / 8);
      return cleanValueWidth(8);
    }
    case "aluFlags":
      emitLoadStateU32(body, stateOffset.aluFlags);
      return cleanValueWidth(32);
  }
}

export function emitInputSlotBits(
  body: WasmFunctionBodyEncoder,
  slot: JitArchitecturalSlot,
  bitOffset: number,
  width: OperandWidth,
  signed: boolean
): ValueWidth | undefined {
  const alias = slot.kind === "aluFlags" ? undefined : jitRegisterSlotAlias(slot);

  if (
    alias === undefined ||
    !Number.isInteger(bitOffset) ||
    bitOffset < 0 ||
    bitOffset % 8 !== 0 ||
    bitOffset + width > alias.width
  ) {
    return undefined;
  }

  const offset = stateOffset[alias.base] + (alias.bitOffset + bitOffset) / 8;

  switch (width) {
    case 8:
      if (signed) {
        emitLoadStateS8(body, offset);
        return cleanValueWidth(32);
      }

      emitLoadStateU8(body, offset);
      return cleanValueWidth(8);
    case 16:
      if (signed) {
        emitLoadStateS16(body, offset);
        return cleanValueWidth(32);
      }

      emitLoadStateU16(body, offset);
      return cleanValueWidth(16);
    case 32:
      if (bitOffset !== 0) {
        return undefined;
      }

      emitLoadStateU32(body, offset);
      return cleanValueWidth(32);
  }
}
