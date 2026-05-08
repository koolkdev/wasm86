import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { IR_ALU_FLAG_MASK, IR_ALU_FLAG_MASKS } from "#x86/ir/model/flag-effects.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
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

test("JIT flag state materializes only requested pending flags", () => {
  const body = new WasmFunctionBodyEncoder(3);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const conditionLocal = body.addLocal(wasmValueType.i32);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("ZF materialization from add should not load incoming aluFlags");
    },
    emitLoadAluFlagsValue: () => {
      throw new Error("ZF materialization from add should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("flags.materialize should not store aluFlags");
    }
  });

  flags.emitSet(createIrFlagSetOp("add", { left: v(0), right: v(1), result: v(2) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  flags.emitMaterialize(IR_ALU_FLAG_MASKS.ZF);
  flags.emitAluFlagsCondition("E");
  body.localSet(conditionLocal).end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(opcodes.includes(wasmOpcode.i32LtU), false);
  strictEqual(opcodes.includes(wasmOpcode.i32Popcnt), false);
  strictEqual(opcodes.includes(wasmOpcode.i32ShrU), false);
});

test("JIT flag state emits supported pending flag conditions directly", () => {
  const body = new WasmFunctionBodyEncoder(3);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const conditionLocal = body.addLocal(wasmValueType.i32);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("direct sub condition should not load incoming aluFlags");
    },
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
  flags.emitAluFlagsCondition("E");
  body.localSet(conditionLocal).end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.localSet), 4);
});

test("JIT flag state keeps const pending flag inputs direct", () => {
  const body = new WasmFunctionBodyEncoder(3);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const conditionLocal = body.addLocal(wasmValueType.i32);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("direct sub condition should not load incoming aluFlags");
    },
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
  flags.emitAluFlagsCondition("E");
  body.localSet(conditionLocal).end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.localSet), 3);
});

test("JIT flag state releases cached pending inputs after materialization", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const handle = trackedCachedHandle(0);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("logic materialization should not load incoming aluFlags");
    },
    emitLoadAluFlagsValue: () => {
      throw new Error("logic materialization should not merge incoming aluFlags");
    },
    emitStoreAluFlags: () => {
      throw new Error("flags.materialize should not store aluFlags");
    },
    valueCache: cachedFlagValueCache([handle])
  });

  flags.emitSet(createIrFlagSetOp("logic", { result: v(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });

  strictEqual(handle.releaseCount(), 0);

  flags.emitMaterialize(IR_ALU_FLAG_MASK);
  body.end();

  strictEqual(handle.releaseCount(), 1);
});

test("JIT flag state releases cached pending inputs when overwritten", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const first = trackedCachedHandle(0);
  const second = trackedCachedHandle(0);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("overwritten logic flags should not load incoming aluFlags");
    },
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

test("JIT flag state releases cached pending inputs when stored", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const handle = trackedCachedHandle(0);
  let stored = false;
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("logic boundary should not load incoming aluFlags");
    },
    emitLoadAluFlagsValue: () => {
      throw new Error("logic boundary should not merge incoming aluFlags");
    },
    emitStoreAluFlags: (emitValue) => {
      stored = true;
      emitValue();
      body.localSet(aluFlagsLocal);
    },
    valueCache: cachedFlagValueCache([handle])
  });

  flags.emitSet(createIrFlagSetOp("logic", { result: v(0) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  flags.emitBoundary(IR_ALU_FLAG_MASK);
  body.end();

  strictEqual(stored, true);
  strictEqual(handle.releaseCount(), 1);
});

test("JIT flag state releases cached pending inputs after exit snapshot capture", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const handle = trackedCachedHandle(0);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("logic exit snapshot should not load incoming aluFlags");
    },
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
  strictEqual(flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK)?.mask, IR_ALU_FLAG_MASK);
  body.end();

  strictEqual(handle.releaseCount(), 1);
});

test("JIT flag state keeps cached pending inputs after non-consuming exit snapshot capture", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const handle = trackedCachedHandle(0);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("logic non-consuming exit snapshot should not load incoming aluFlags");
    },
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

  strictEqual(flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK, { consume: false })?.mask, IR_ALU_FLAG_MASK);
  strictEqual(handle.releaseCount(), 0);

  flags.emitMaterialize(IR_ALU_FLAG_MASK);
  body.end();

  strictEqual(handle.releaseCount(), 1);
});

test("JIT flag state releases cached pending inputs after non-consuming then consuming snapshots", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const aluFlagsLocal = body.addLocal(wasmValueType.i32);
  const handle = trackedCachedHandle(0);
  const flags = createJitFlagState(body, aluFlagsLocal, {
    emitLoadAluFlags: () => {
      throw new Error("logic branch exit snapshots should not load incoming aluFlags");
    },
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

  strictEqual(flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK, { consume: false })?.mask, IR_ALU_FLAG_MASK);
  strictEqual(handle.releaseCount(), 0);
  strictEqual(flags.captureExitStoreSnapshot(IR_ALU_FLAG_MASK)?.mask, IR_ALU_FLAG_MASK);
  body.end();

  strictEqual(handle.releaseCount(), 1);
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
  let releases = 0;
  let released = false;

  return {
    local,
    valueWidth: cleanValueWidth(32),
    retain: () => trackedCachedHandle(local),
    release: () => {
      if (released) {
        throw new Error("tracked cached handle released twice");
      }

      released = true;
      releases += 1;
    },
    releaseCount: () => releases
  };
}
