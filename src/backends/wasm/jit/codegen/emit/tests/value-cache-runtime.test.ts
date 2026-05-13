import {
  deepStrictEqual,
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  wasmOpcode,
  IR_ALU_FLAG_MASK,
  extractOnlyWasmFunctionBody,
  wasmBodyOpcodes,
  createJitValueCacheRuntime,
  encodeJitIrBlock,
  planJitExpressionValueCache,
  buildJitInstructionValueTimeline,
  createJitValueState,
  emitPlannedExpression,
  reg,
  const32,
  addExpr,
  parentExpr,
  highCostExpr,
  localOpcodes,
  countOpcode,
  repeatedInlineExpressionBlock,
} from "./value-local-store-test-helpers.js";
test("JIT expression emission snapshots cached branch-arm expression vars independently", () => {
  const opcodes = wasmBodyOpcodes(extractOnlyWasmFunctionBody(encodeJitIrBlock([repeatedInlineExpressionBlock()])));

  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 2);
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

test("JIT value-cache planning does not treat flags.set as a materialization consumer", () => {
  const expressionBlock = [
    { op: "let32", dst: { kind: "var", id: 0 }, value: highCostExpr() },
    {
      op: "flags.set",
      producer: "logic",
      writtenMask: IR_ALU_FLAG_MASK,
      undefMask: 0,
      inputs: {
        result: { kind: "var", id: 0 }
      }
    },
    { op: "next" }
  ] as const;
  const valueTimeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: createJitValueState().snapshot()
  });

  strictEqual(planJitExpressionValueCache({
    operands: [],
    valueTimeline
  }, expressionBlock), undefined);
});
