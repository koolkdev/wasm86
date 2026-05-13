import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { stateOffset } from "#backends/wasm/abi.js";
import { ok, decodeBytes, startAddress } from "#x86/isa/decoder/tests/helpers.js";
import { cleanValueWidth, type ValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import {
  extractOnlyWasmFunctionBody,
  wasmBodyMemoryAccesses,
  wasmBodyLocalCount,
  wasmBodyInstructions,
  wasmBodyOpcodes
} from "#backends/wasm/tests/body-opcodes.js";
import { jitInputAluFlagsValue, type JitValue } from "#backends/wasm/jit/ir/values.js";
import {
  createJitValueCacheRuntime,
  JitValueLocalStore,
  type JitValueCacheRuntime,
  type JitValueUseCount
} from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import {
  captureJitExitMaterializationStores,
  emitJitExitMaterializationStores,
  releaseJitExitMaterializationStores
} from "#backends/wasm/jit/codegen/emit/exit-stores.js";
import { buildJitIrBlock, encodeJitIrBlock } from "#backends/wasm/jit/block.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { emitJitBlock } from "#backends/wasm/jit/codegen/emit/block-emitter.js";
import { planJitExpressionValueCache } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { buildJitInstructionValueTimeline } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import {
  instructionEntry,
  instructionExit
} from "#backends/wasm/jit/codegen/plan/plan.js";
import type {
  JitBoundaryRef,
  JitStateSnapshot
} from "#backends/wasm/jit/codegen/plan/types.js";
import { createJitIrState } from "#backends/wasm/jit/state/state.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import type { Reg32 } from "#x86/isa/types.js";
import { emitPlannedExpression } from "./expression-cache-test-helpers.js";

export {
  deepStrictEqual,
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  WasmLocalScratchAllocator,
  wasmOpcode,
  wasmValueType,
  ExitReason,
  stateOffset,
  ok,
  decodeBytes,
  startAddress,
  cleanValueWidth,
  IR_ALU_FLAG_MASK,
  extractOnlyWasmFunctionBody,
  wasmBodyMemoryAccesses,
  wasmBodyLocalCount,
  wasmBodyInstructions,
  wasmBodyOpcodes,
  jitInputAluFlagsValue,
  createJitValueCacheRuntime,
  JitValueLocalStore,
  captureJitExitMaterializationStores,
  emitJitExitMaterializationStores,
  releaseJitExitMaterializationStores,
  buildJitIrBlock,
  encodeJitIrBlock,
  emitJitBlock,
  planJitExpressionValueCache,
  buildJitInstructionValueTimeline,
  instructionEntry,
  instructionExit,
  createJitIrState,
  createJitValueState,
  emitPlannedExpression
};
export type {
  ValueWidth,
  IrStorageExpr,
  IrValueExpr,
  JitValue,
  JitValueCacheRuntime,
  JitValueUseCount,
  JitIrBlock,
  JitBoundaryRef,
  JitStateSnapshot,
  Reg32
};

export function addValue(reg: "eax" | "ebx", value: number): JitValue {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: { kind: "reg", reg },
    b: { kind: "const", type: "i32", value }
  };
}

export function highCostValue(): JitValue {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "or",
    a: {
      kind: "value.binary",
      type: "i32",
      operator: "xor",
      a: addValue("eax", 1),
      b: addValue("ebx", 2)
    },
    b: { kind: "reg", reg: "edx" }
  };
}

export function useCounts(counts: readonly JitValueUseCount[]): readonly JitValueUseCount[] {
  return counts;
}

export function cacheRuntimeForStore(store: JitValueLocalStore): JitValueCacheRuntime {
  return {
    beginInstruction: () => {},
    beginExpressionOp: () => {},
    snapshotAvailability: () => ({
      currentEpoch: 0,
      store: store.snapshotAvailability()
    }),
    restoreAvailability: (snapshot) => {
      store.restoreAvailability(snapshot.store);
    },
    emitForUse: (value, emitter) => store.emitForUseWithLocal(value, emitter),
    captureForReuse: (value, emitter) => store.captureForReuse(value, emitter),
    canEmitInline: () => true,
    valueForExpression: () => undefined,
    valueForValueRef: () => undefined
  };
}

export function reg(regName: Reg32): IrStorageExpr {
  return { kind: "reg", reg: regName };
}

export function const32(value: number): IrValueExpr {
  return { kind: "const", type: "i32", value };
}

export function addExpr(regName: Reg32, value: number): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: { kind: "source", source: reg(regName), accessWidth: 32 },
    b: const32(value)
  };
}

export function xorExpr(a: IrValueExpr, b: IrValueExpr): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a,
    b
  };
}

export function parentExpr(): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: addExpr("eax", 1),
    b: const32(0xff)
  };
}

export function highCostExpr(): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "or",
    a: {
      kind: "value.binary",
      type: "i32",
      operator: "xor",
      a: addExpr("eax", 1),
      b: addExpr("ebx", 2)
    },
    b: {
      kind: "source",
      source: reg("ecx"),
      accessWidth: 32
    }
  };
}

export function emitAdd(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(10).i32Const(1).i32Add();
  return cleanValueWidth(32);
}

export function emitXorOfAdds(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(10).i32Const(1).i32Add();
  body.i32Const(20).i32Const(2).i32Add();
  body.i32Xor();
  return cleanValueWidth(32);
}

export function emitHighCostValue(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  emitXorOfAdds(body, onEmit);
  body.i32Const(30).i32Or();
  return cleanValueWidth(32);
}

export function emitConst(body: WasmFunctionBodyEncoder, value: number, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(value);
  return cleanValueWidth(32);
}

export function emitExtend8(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(0x80).i32Extend8S();
  return cleanValueWidth(32);
}

export function unexpectedEmitter(): ValueWidth {
  throw new Error("unexpected value emission");
}

export function localOpcodes(opcodes: readonly number[]): readonly number[] {
  return opcodes.filter((opcode) =>
    opcode === wasmOpcode.localGet ||
    opcode === wasmOpcode.localSet ||
    opcode === wasmOpcode.localTee
  );
}

export function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodes.filter((entry) => entry === opcode).length;
}

export function boundaryState(
  boundary: JitBoundaryRef,
  instructionCountDelta: number
): JitStateSnapshot {
  return {
    boundary,
    instructionCountDelta,
    valueState: createJitValueState().snapshot()
  };
}

export function repeatedInlineExpressionBlock(): JitIrBlock {
  return {
    instructions: [{
      instructionId: "cache-test",
      eip: 0x1000,
      nextEip: 0x1001,
      nextMode: "exit",
      operands: [],
      ir: [
        { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "reg", reg: "eax" } },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 1 },
          a: { kind: "var", id: 0 },
          b: { kind: "const", type: "i32", value: 1 }
        },
        { op: "get", dst: { kind: "var", id: 2 }, source: { kind: "reg", reg: "eax" } },
        {
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst: { kind: "var", id: 3 },
          a: { kind: "var", id: 2 },
          b: { kind: "const", type: "i32", value: 1 }
        },
        {
          op: "conditionalJump",
          condition: { kind: "const", type: "i32", value: 0 },
          taken: { kind: "var", id: 1 },
          notTaken: { kind: "var", id: 3 }
        }
      ]
    }]
  };
}
