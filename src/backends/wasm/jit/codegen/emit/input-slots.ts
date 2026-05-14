import { stateOffset } from "#backends/wasm/abi.js";
import {
  emitLoadStateS8,
  emitLoadStateS16,
  emitLoadStateU8,
  emitLoadStateU16,
  emitLoadStateU32
} from "#backends/wasm/codegen/state.js";
import { cleanValueWidth, type ValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { JitArchitecturalSlot } from "#backends/wasm/jit/ir/value-types.js";
import type { OperandWidth } from "#x86/isa/types.js";

export function emitJitInputSlot(body: WasmFunctionBodyEncoder, slot: JitArchitecturalSlot): ValueWidth {
  switch (slot.kind) {
    case "reg32":
      emitLoadStateU32(body, stateOffset[slot.reg]);
      return cleanValueWidth(32);
    case "aluFlags":
      emitLoadStateU32(body, stateOffset.aluFlags);
      return cleanValueWidth(32);
  }
}

export function emitJitInputSlotBits(
  body: WasmFunctionBodyEncoder,
  slot: JitArchitecturalSlot,
  bitOffset: number,
  width: OperandWidth,
  signed: boolean
): ValueWidth | undefined {
  if (
    slot.kind !== "reg32" ||
    !Number.isInteger(bitOffset) ||
    bitOffset < 0 ||
    bitOffset % 8 !== 0 ||
    bitOffset + width > 32
  ) {
    return undefined;
  }

  const offset = stateOffset[slot.reg] + bitOffset / 8;

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
