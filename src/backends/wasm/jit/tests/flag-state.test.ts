import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { wasmBodyLocalCount, wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { createJitFlagState } from "#backends/wasm/jit/state/flag-state.js";
import {
  cleanValueWidth,
  constValueWidth,
  emitMaskValueToWidth,
  untrackedValueWidth,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import type {
  JitCachedValueHandle,
  JitValueCacheRuntime
} from "#backends/wasm/jit/codegen/emit/value-local-store.js";

test("JIT flag state emits pending flag conditions from source calculations", () => {
  const body = new WasmFunctionBodyEncoder(3);
  const conditionLocal = body.addLocal(wasmValueType.i32);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("direct add condition should not load incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("direct add condition should not store aluFlags");
    }
  });

  flags.emitSet(createIrFlagSetOp("add", { left: v(0), right: v(1), result: v(2) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  flags.emitFlagsCondition("E");
  body.localSet(conditionLocal).end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(opcodes.includes(wasmOpcode.i32LtU), false);
  strictEqual(opcodes.includes(wasmOpcode.i32Popcnt), false);
  strictEqual(opcodes.includes(wasmOpcode.i32ShrU), false);
});

test("JIT flag state emits supported pending flag conditions directly", () => {
  const body = new WasmFunctionBodyEncoder(3);
  const conditionLocal = body.addLocal(wasmValueType.i32);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("direct sub condition should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("direct sub condition should not store aluFlags");
    }
  });

  flags.emitSet(createIrFlagSetOp("sub", { left: v(0), right: v(1), result: v(2) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  flags.emitFlagsCondition("E");
  body.localSet(conditionLocal).end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.localSet), 4);
});

test("JIT flag state keeps const pending flag inputs direct", () => {
  const body = new WasmFunctionBodyEncoder(3);
  const conditionLocal = body.addLocal(wasmValueType.i32);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("direct sub condition should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("direct sub condition should not store aluFlags");
    }
  });

  flags.emitSet(createIrFlagSetOp("sub", { left: v(0), right: c32(1), result: v(1) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  flags.emitFlagsCondition("E");
  body.localSet(conditionLocal).end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.localSet), 3);
});

test("JIT flag state emits incoming flag conditions without a fallback local", () => {
  const body = new WasmFunctionBodyEncoder(0);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      body.i32Const(1);
    },
    emitStoreAluFlags: () => {
      throw new Error("incoming condition should not store aluFlags");
    }
  });

  flags.emitFlagsCondition("B");
  body.end();

  strictEqual(wasmBodyLocalCount(body.encode()), 0);
});

test("JIT flag state releases cached pending inputs when pending owners are released", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const handle = trackedCachedHandle(0);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("pending-owner release should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("pending-owner release should not store aluFlags");
    },
    valueCache: cachedFlagValueCache([handle])
  });

  flags.emitSet(createIrFlagSetOp("logic", { result: v(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });

  strictEqual(handle.releaseCount(), 0);

  flags.releasePendingOwners();
  body.end();

  strictEqual(handle.releaseCount(), 1);
});

test("JIT flag state releases cached pending inputs when overwritten", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const first = trackedCachedHandle(0);
  const second = trackedCachedHandle(0);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("overwritten logic flags should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("overwritten logic flags should not store aluFlags");
    },
    valueCache: cachedFlagValueCache([first, second])
  });

  flags.emitSet(createIrFlagSetOp("logic", { result: v(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  flags.emitSet(createIrFlagSetOp("logic", { result: v(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  body.end();

  strictEqual(first.releaseCount(), 1);
  strictEqual(second.releaseCount(), 0);
});

test("JIT flag state excludes overwritten partial flag sources from symbolic snapshots", () => {
  const body = new WasmFunctionBodyEncoder(2);
  const firstLeft = trackedCachedHandle(0);
  const firstResult = trackedCachedHandle(1);
  const secondLeft = trackedCachedHandle(0);
  const secondResult = trackedCachedHandle(1);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("symbolic snapshot capture should not load incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("symbolic snapshot capture should not store aluFlags");
    },
    valueCache: cachedFlagValueCache([firstLeft, firstResult, secondLeft, secondResult])
  });

  flags.emitSet(createIrFlagSetOp("inc", { left: v(0), result: v(1) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  flags.emitSet(createIrFlagSetOp("inc", { left: v(0), result: v(1) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });

  strictEqual(firstLeft.releaseCount(), 1);
  strictEqual(firstResult.releaseCount(), 1);
  strictEqual(secondLeft.releaseCount(), 0);
  strictEqual(secondResult.releaseCount(), 0);

  const snapshot = flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK);

  strictEqual(snapshot?.mask, IR_ALU_FLAG_MASK);
  strictEqual(secondLeft.releaseCount(), 0);
  strictEqual(secondResult.releaseCount(), 0);
  flags.releaseExitSnapshot(snapshot!);
  body.end();

  strictEqual(secondLeft.releaseCount(), 1);
  strictEqual(secondResult.releaseCount(), 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 0);
});

test("JIT flag state retains cached pending inputs until exit snapshot release", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const handle = trackedCachedHandle(0);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("logic exit snapshot should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("logic exit snapshot capture should not store aluFlags");
    },
    valueCache: cachedFlagValueCache([handle])
  });

  flags.emitSet(createIrFlagSetOp("logic", { result: v(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });

  strictEqual(handle.releaseCount(), 0);
  const snapshot = flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK);

  strictEqual(snapshot?.mask, IR_ALU_FLAG_MASK);
  strictEqual(handle.releaseCount(), 0);
  flags.releaseExitSnapshot(snapshot!);
  body.end();

  strictEqual(handle.releaseCount(), 1);
});

test("JIT flag state keeps pending owner after exit snapshot release", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const handle = trackedCachedHandle(0);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("logic non-consuming exit snapshot should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("logic non-consuming exit snapshot should not store aluFlags");
    },
    valueCache: cachedFlagValueCache([handle])
  });

  flags.emitSet(createIrFlagSetOp("logic", { result: v(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });

  const snapshot = flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK);

  strictEqual(snapshot?.mask, IR_ALU_FLAG_MASK);
  strictEqual(handle.releaseCount(), 0);
  flags.releaseExitSnapshot(snapshot!);
  strictEqual(handle.releaseCount(), 1);

  flags.releasePendingOwners();
  body.end();

  strictEqual(handle.releaseCount(), 2);
});

test("JIT flag state releases two branch snapshots from the same pending flags independently", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const handle = trackedCachedHandle(0);
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("logic branch exit snapshots should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("logic branch exit snapshot capture should not store aluFlags");
    },
    valueCache: cachedFlagValueCache([handle])
  });

  flags.emitSet(createIrFlagSetOp("logic", { result: v(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });

  const first = flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK);
  const second = flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK);

  strictEqual(first?.mask, IR_ALU_FLAG_MASK);
  strictEqual(second?.mask, IR_ALU_FLAG_MASK);
  strictEqual(handle.releaseCount(), 0);
  flags.releaseExitSnapshot(first!);
  strictEqual(handle.releaseCount(), 1);
  flags.releaseExitSnapshot(second!);
  body.end();

  strictEqual(handle.releaseCount(), 2);
});

test("JIT flag state captures full-mask single pending source without an accumulator local", () => {
  const body = new WasmFunctionBodyEncoder();
  const flags = createJitFlagState(body, {
    emitLoadAluFlagsValue: () => {
      throw new Error("single pending snapshot should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("single pending snapshot capture should not store aluFlags");
    }
  });

  flags.emitSet(createIrFlagSetOp("logic", { result: c32(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });

  strictEqual(flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK)?.mask, IR_ALU_FLAG_MASK);
  body.end();

  strictEqual(wasmBodyLocalCount(body.encode()), 0);
});

function emitValueExpr(body: WasmFunctionBodyEncoder, value: IrValueExpr): ValueWidth {
  switch (value.kind) {
    case "var":
      body.localGet(value.id);
      return untrackedValueWidth();
    case "const":
      body.i32Const(i32(value.value));
      return constValueWidth(value.value);
    case "nextEip":
      throw new Error("nextEip is not a valid flag test input");
    default:
      throw new Error(`unsupported flag test value expression: ${value.kind}`);
  }
}

function v(id: number): ValueRef {
  return { kind: "var", id };
}

function c32(value: number): ValueRef {
  return { kind: "const", type: "i32", value };
}

function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodes.filter((entry) => entry === opcode).length;
}

function cachedFlagValueCache(handles: JitCachedValueHandle[]): JitValueCacheRuntime {
  return {
    beginInstruction: () => {},
    notifyWrite: () => {},
    emitForUse: (_value, emitter) => emitter(),
    emitJitValueForUse: (_value, emitter) => ({ valueWidth: emitter() }),
    captureForReuse: () => undefined,
    captureJitValueForReuse: () => {
      const handle = handles.shift();

      if (handle === undefined) {
        throw new Error("missing cached flag value handle");
      }

      return { ...handle, emitted: false };
    },
    jitValueForExpression: () => undefined,
    jitValueForValueRef: (value) => value.kind === "var" ? { kind: "reg", reg: "eax" } : undefined
  };
}

function trackedCachedHandle(local: number): JitCachedValueHandle & Readonly<{
  releaseCount(): number;
}> {
  const state = { releases: 0 };

  return trackedCachedHandleWithState(local, state);
}

function trackedCachedHandleWithState(
  local: number,
  state: { releases: number }
): JitCachedValueHandle & Readonly<{
  releaseCount(): number;
}> {
  let released = false;

  return {
    local,
    valueWidth: cleanValueWidth(32),
    retain: () => trackedCachedHandleWithState(local, state),
    release: () => {
      if (released) {
        throw new Error("tracked cached handle released twice");
      }

      released = true;
      state.releases += 1;
    },
    releaseCount: () => state.releases
  };
}
