import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { ok, decodeBytes, startAddress } from "#x86/isa/decoder/tests/helpers.js";
import { cleanValueWidth, type ValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import {
  extractOnlyWasmFunctionBody,
  wasmBodyLocalCount,
  wasmBodyInstructions,
  wasmBodyOpcodes
} from "#backends/wasm/tests/body-opcodes.js";
import type { JitValue } from "#backends/wasm/jit/ir/values.js";
import {
  createJitValueCacheRuntime,
  JitValueLocalStore,
  type JitValueUseCount
} from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import { buildJitIrBlock, encodeJitIrBlock } from "#backends/wasm/jit/block.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import { emitJitIrWithContext } from "#backends/wasm/jit/codegen/emit/ir-context.js";
import { planJitExpressionValueCache } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { buildJitInstructionValueTimeline } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import type { JitStateSnapshot } from "#backends/wasm/jit/codegen/plan/types.js";
import { createJitIrState } from "#backends/wasm/jit/state/state.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import type { Reg32 } from "#x86/isa/types.js";
import { createJitReg32State } from "#backends/wasm/jit/state/register-state.js";
import { emitPlannedExpression } from "./expression-cache-test-helpers.js";

test("JitValueLocalStore reuses one local for equal non-trivial values", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = addValue("eax", 1);
  const second = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value: first, useCount: 2 }]));
  let emitted = 0;

  store.emitForUse(first, () => emitAdd(body, () => { emitted += 1; }));
  store.emitForUse(second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Add), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("JitValueLocalStore reuses structurally equal binary expressions", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: addValue("eax", 1),
    b: addValue("ebx", 2)
  } as const satisfies JitValue;
  const second = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: addValue("eax", 1),
    b: addValue("ebx", 2)
  } as const satisfies JitValue;
  const store = new JitValueLocalStore(body, useCounts([{ value: first, useCount: 2 }]));
  let emitted = 0;

  store.emitForUse(first, () => emitXorOfAdds(body, () => { emitted += 1; }));
  store.emitForUse(second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("JitValueLocalStore reuses high-cost retained expressions through one local", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = highCostValue();
  const second = highCostValue();
  const store = new JitValueLocalStore(body, useCounts([{ value: first, useCount: 2 }]));
  let emitted = 0;

  store.emitForUse(first, () => emitHighCostValue(body, () => { emitted += 1; }));
  store.emitForUse(second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("JitValueLocalStore does not cache unselected high-cost retained expressions", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = highCostValue();
  const store = new JitValueLocalStore(body, useCounts([]));
  let emitted = 0;

  store.emitForUse(value, () => emitHighCostValue(body, () => { emitted += 1; }));
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 1);
  deepStrictEqual(localOpcodes(opcodes), []);
});

test("JitValueLocalStore does not cache unselected constants", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = { kind: "const", type: "i32", value: 7 } as const satisfies JitValue;
  const store = new JitValueLocalStore(body, useCounts([]));
  let emitted = 0;

  store.emitForUse(value, () => emitConst(body, 7, () => { emitted += 1; }));
  store.emitForUse(value, () => emitConst(body, 7, () => { emitted += 1; }));
  store.emitForUse(value, () => emitConst(body, 7, () => { emitted += 1; }));
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 3);
  strictEqual(wasmBodyLocalCount(body.encode()), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Const), 3);
  deepStrictEqual(localOpcodes(opcodes), []);
});

test("JitValueLocalStore does not cache unselected tied-cost expressions", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = {
    kind: "value.unary",
    type: "i32",
    operator: "extend8_s",
    value: { kind: "reg", reg: "eax" }
  } as const satisfies JitValue;
  const store = new JitValueLocalStore(body, useCounts([]));
  let emitted = 0;

  store.emitForUse(value, () => emitExtend8(body, () => { emitted += 1; }));
  store.emitForUse(value, () => emitExtend8(body, () => { emitted += 1; }));
  body.end();

  strictEqual(emitted, 2);
  strictEqual(wasmBodyLocalCount(body.encode()), 0);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), []);
});

test("JitValueLocalStore captureForReuse reports whether it emitted local.set", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 2 }]));
  let emitted = 0;

  const first = store.captureForReuse(value, () => emitAdd(body, () => { emitted += 1; }));
  const second = store.captureForReuse(value, unexpectedEmitter);

  strictEqual(first?.emitted, true);
  strictEqual(second?.emitted, false);
  strictEqual(second?.local, first?.local);
  store.emitForUse(value, unexpectedEmitter);
  body.end();

  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localGet]);
});

test("JitValueLocalStore retires invalidated locals before rematerializing", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const first = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (first === undefined) {
    throw new Error("expected first materialization");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const second = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (second === undefined) {
    throw new Error("expected second materialization");
  }

  body.end();

  strictEqual(first.local === second.local, false);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("JitValueLocalStore reuses non-escaped locals after invalidation", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const first = store.emitForUseWithLocal(value, () => emitAdd(body, () => {}));

  if (first.local === undefined) {
    throw new Error("expected first cached local");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const second = store.emitForUseWithLocal(value, () => emitAdd(body, () => {}));

  if (second.local === undefined) {
    throw new Error("expected second cached local");
  }

  body.end();

  strictEqual(second.local, first.local);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee, wasmOpcode.localTee]);
});

test("JitValueLocalStore retires locals that become escaped while available", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const first = store.emitForUseWithLocal(value, () => emitAdd(body, () => {}));

  if (first.local === undefined) {
    throw new Error("expected first cached local");
  }

  const escaped = store.captureForReuse(value, unexpectedEmitter);

  if (escaped === undefined) {
    throw new Error("expected escaped cached local");
  }

  strictEqual(escaped.local, first.local);
  strictEqual(escaped.emitted, false);

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const rematerialized = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (rematerialized === undefined) {
    throw new Error("expected rematerialized cached local");
  }

  body.end();

  strictEqual(rematerialized.local === first.local, false);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee, wasmOpcode.localSet]);
});

test("JitValueLocalStore reuses retired escaped locals after owners release", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const first = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (first === undefined) {
    throw new Error("expected first materialization");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");
  first.release();

  const second = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (second === undefined) {
    throw new Error("expected second materialization");
  }

  body.end();

  strictEqual(second.local, first.local);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("JitValueLocalStore restoreAvailability hides branch-local captures from sibling arms", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const branchAvailability = store.snapshotAvailability();
  let emitted = 0;

  const taken = store.captureForReuse(value, () => emitAdd(body, () => { emitted += 1; }));

  if (taken === undefined) {
    throw new Error("expected taken branch materialization");
  }

  store.restoreAvailability(branchAvailability);

  const notTaken = store.captureForReuse(value, () => emitAdd(body, () => { emitted += 1; }));

  if (notTaken === undefined) {
    throw new Error("expected not-taken branch materialization");
  }

  body.end();

  strictEqual(taken.emitted, true);
  strictEqual(notTaken.emitted, true);
  strictEqual(taken.local === notTaken.local, false);
  strictEqual(emitted, 2);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("JitValueLocalStore restoreAvailability preserves values available before branch split", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  let emitted = 0;

  const preBranch = store.emitForUseWithLocal(value, () => emitAdd(body, () => { emitted += 1; }));

  if (preBranch.local === undefined) {
    throw new Error("expected pre-branch cached local");
  }

  const branchAvailability = store.snapshotAvailability();
  const taken = store.captureForReuse(value, unexpectedEmitter);

  store.restoreAvailability(branchAvailability);

  const notTaken = store.captureForReuse(value, unexpectedEmitter);

  body.end();

  strictEqual(taken?.emitted, false);
  strictEqual(notTaken?.emitted, false);
  strictEqual(taken?.local, preBranch.local);
  strictEqual(notTaken?.local, preBranch.local);
  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee]);
});

test("JitValueLocalStore keeps pinned exit snapshot locals out of reuse", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const regs = createJitReg32State(body);
  const captured = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (captured === undefined) {
    throw new Error("expected captured cached local");
  }

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias({ name: "eax", base: "eax", bitOffset: 0, width: 32 }, {
    emitValue: unexpectedEmitter,
    prefixSource: { kind: "local", local: captured.local, width: 32, owner: captured }
  });
  regs.commitPending();

  const snapshot = regs.captureCommittedExitStores(["eax"]);

  regs.emitWriteAlias({ name: "eax", base: "eax", bitOffset: 0, width: 32 }, () => {
    body.i32Const(2);
    return cleanValueWidth(32);
  });
  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const rematerialized = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (rematerialized === undefined) {
    throw new Error("expected rematerialized cached local");
  }

  regs.emitExitSnapshotStore("eax", snapshot);
  body.end();

  strictEqual(rematerialized.local === captured.local, false);
});

test("JIT expression emission snapshots cached branch-arm expression vars independently", () => {
  const opcodes = wasmBodyOpcodes(extractOnlyWasmFunctionBody(encodeJitIrBlock([repeatedInlineExpressionBlock()])));

  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 2);
});

test("JIT generic register exit capture reuses pure NEG planned values", () => {
  const mov = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const neg = ok(decodeBytes([0xf7, 0xd8], mov.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], neg.nextEip));
  const body = extractOnlyWasmFunctionBody(encodeJitIrBlock([buildJitIrBlock([mov, neg, trap])]));
  const opcodes = wasmBodyOpcodes(body);

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Sub), 1);
});

test("JIT expression cache reuses resolved let32-backed JitValues", () => {
  const opcodes = emitPlannedExpression([
    { op: "let32", dst: { kind: "var", id: 0 }, value: addExpr("eax", 1) },
    { op: "hostTrap", vector: { kind: "var", id: 0 } },
    { op: "hostTrap", vector: { kind: "var", id: 0 } }
  ]);

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Add), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.localGet), 1);
});

test("JIT expression cache does not reuse one-before and one-after clobber", () => {
  const opcodes = emitPlannedExpression([
    { op: "set", target: reg("ebx"), value: addExpr("eax", 1), accessWidth: 32 },
    { op: "set", target: reg("eax"), value: const32(5), accessWidth: 32 },
    { op: "set", target: reg("ecx"), value: addExpr("eax", 1), accessWidth: 32 }
  ]);

  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 0);
});

test("JIT expression cache invalidates cached values across written-register epochs", () => {
  const opcodes = emitPlannedExpression([
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "set", target: reg("eax"), value: const32(5), accessWidth: 32 },
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "hostTrap", vector: addExpr("eax", 1) }
  ]);

  deepStrictEqual(localOpcodes(opcodes).filter((opcode) =>
    opcode === wasmOpcode.localTee ||
    opcode === wasmOpcode.localGet
  ), [wasmOpcode.localTee, wasmOpcode.localGet, wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("JIT value-cache runtime follows planned timeline epoch positions", () => {
  const body = new WasmFunctionBodyEncoder();
  const expressionBlock = [
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "set", target: reg("eax"), value: const32(5), accessWidth: 32 },
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "hostTrap", vector: addExpr("eax", 1) }
  ] as const;
  const timeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: createJitValueState().snapshot()
  });
  const plan = planJitExpressionValueCache({
    operands: [],
    valueTimeline: timeline
  }, expressionBlock);
  const valueCache = createJitValueCacheRuntime(body, plan);

  valueCache?.beginInstruction(0);

  const runtimeEpochs = expressionBlock.map((_op, opIndex) => {
    valueCache?.beginExpressionOp(opIndex);
    return valueCache?.snapshotAvailability().currentEpoch;
  });

  deepStrictEqual(runtimeEpochs, plan?.instructionPlans[0]?.epochByExpressionOpIndex);
  deepStrictEqual(runtimeEpochs, [0, 0, 0, 1, 1]);
});

test("JIT expression cache prefers repeated parent expressions over nested children", () => {
  const opcodes = emitPlannedExpression([
    { op: "hostTrap", vector: parentExpr() },
    { op: "hostTrap", vector: parentExpr() }
  ]);

  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
});

test("JIT emission consumes prebuilt expression blocks from instruction plans", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const state = createJitIrState(body, [{ stores: [], flagMask: 0 }]);
  const entrySnapshot = stateSnapshot("preInstruction", 0x1000, 0);
  const postSnapshot = stateSnapshot("postInstruction", 0x1001, 1);
  const expressionBlock = [
    { op: "hostTrap", vector: xorExpr(const32(0x15), const32(0x3f)) }
  ] as const;

  emitJitIrWithContext({
    body,
    scratch,
    state,
    exit: { exitLocal, exitLabelDepth: 0 },
    instructions: [{
      instructionId: "prebuilt-expression-block",
      eip: 0x1000,
      nextEip: 0x1001,
      nextMode: "continue",
      entryPoint: {
        instructionIndex: 0,
        snapshot: entrySnapshot
      },
      postInstructionState: postSnapshot,
      exitPointCount: 1,
      operands: [],
      expressionBlock,
      valueTimeline: buildJitInstructionValueTimeline({
        operands: [],
        expressionBlock,
        entryValueState: entrySnapshot.valueState
      }),
      sourceExpressionMap: { placementsBySourceOpIndex: new Map() }
    }],
    exitPoints: [{
      instructionIndex: 0,
      opIndex: 0,
      exitReason: ExitReason.HOST_TRAP,
      snapshot: postSnapshot,
      exitMaterializationIndex: 0
    }]
  });
  scratch.assertClear();
  body.end();

  const encoded = body.encode();
  const instructions = wasmBodyInstructions(encoded);
  const vectorStoreIndex = instructions.findIndex((instruction, index) =>
    instruction.opcode === wasmOpcode.localSet &&
      instructions[index - 1]?.opcode === wasmOpcode.i32Xor
  );

  strictEqual(countOpcode(wasmBodyOpcodes(encoded), wasmOpcode.br), 1);
  strictEqual(vectorStoreIndex !== -1, true);

  const vectorLocal = instructions[vectorStoreIndex]?.local;
  const payloadExtendIndex = instructions.findIndex((instruction) =>
    instruction.opcode === wasmOpcode.i64ExtendI32U
  );
  const payloadGetIndex = instructions.findIndex((instruction, index) =>
    instruction.opcode === wasmOpcode.localGet &&
      instruction.local === vectorLocal &&
      index > vectorStoreIndex &&
      index < payloadExtendIndex
  );

  strictEqual(payloadExtendIndex > vectorStoreIndex, true);
  strictEqual(payloadGetIndex !== -1, true);
});

test("JitValueLocalStore forgetWhere invalidates only matching values", () => {
  const body = new WasmFunctionBodyEncoder();
  const eax = addValue("eax", 1);
  const ebx = addValue("ebx", 1);
  const store = new JitValueLocalStore(body, useCounts([
    { value: eax, useCount: 2 },
    { value: ebx, useCount: 2 }
  ]));
  let eaxEmits = 0;
  let ebxEmits = 0;

  store.emitForUse(eax, () => emitAdd(body, () => { eaxEmits += 1; }));
  store.emitForUse(ebx, () => emitAdd(body, () => { ebxEmits += 1; }));
  store.forgetWhere((value) => value.kind === "value.binary" && value.a.kind === "reg" && value.a.reg === "eax");
  store.emitForUse(eax, () => emitAdd(body, () => { eaxEmits += 1; }));
  store.emitForUse(ebx, unexpectedEmitter);
  body.end();

  strictEqual(eaxEmits, 2);
  strictEqual(ebxEmits, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [
    wasmOpcode.localTee,
    wasmOpcode.localTee,
    wasmOpcode.localTee,
    wasmOpcode.localGet
  ]);
});

function addValue(reg: "eax" | "ebx", value: number): JitValue {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: { kind: "reg", reg },
    b: { kind: "const", type: "i32", value }
  };
}

function highCostValue(): JitValue {
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

function useCounts(counts: readonly JitValueUseCount[]): readonly JitValueUseCount[] {
  return counts;
}

function reg(regName: Reg32): IrStorageExpr {
  return { kind: "reg", reg: regName };
}

function const32(value: number): IrValueExpr {
  return { kind: "const", type: "i32", value };
}

function addExpr(regName: Reg32, value: number): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: { kind: "source", source: reg(regName), accessWidth: 32 },
    b: const32(value)
  };
}

function xorExpr(a: IrValueExpr, b: IrValueExpr): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a,
    b
  };
}

function parentExpr(): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: addExpr("eax", 1),
    b: const32(0xff)
  };
}

function emitAdd(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(10).i32Const(1).i32Add();
  return cleanValueWidth(32);
}

function emitXorOfAdds(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(10).i32Const(1).i32Add();
  body.i32Const(20).i32Const(2).i32Add();
  body.i32Xor();
  return cleanValueWidth(32);
}

function emitHighCostValue(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  emitXorOfAdds(body, onEmit);
  body.i32Const(30).i32Or();
  return cleanValueWidth(32);
}

function emitConst(body: WasmFunctionBodyEncoder, value: number, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(value);
  return cleanValueWidth(32);
}

function emitExtend8(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(0x80).i32Extend8S();
  return cleanValueWidth(32);
}

function unexpectedEmitter(): ValueWidth {
  throw new Error("unexpected value emission");
}

function localOpcodes(opcodes: readonly number[]): readonly number[] {
  return opcodes.filter((opcode) =>
    opcode === wasmOpcode.localGet ||
    opcode === wasmOpcode.localSet ||
    opcode === wasmOpcode.localTee
  );
}

function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodes.filter((entry) => entry === opcode).length;
}

function stateSnapshot(
  kind: JitStateSnapshot["kind"],
  eip: number,
  instructionCountDelta: number
): JitStateSnapshot {
  return {
    kind,
    eip,
    instructionCountDelta,
    valueState: createJitValueState().snapshot(),
    committedFlags: { mask: 0 },
    speculativeFlags: { mask: 0 }
  };
}

function repeatedInlineExpressionBlock(): JitIrBlock {
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
