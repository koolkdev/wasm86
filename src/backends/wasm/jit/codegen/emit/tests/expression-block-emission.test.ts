import {
  deepStrictEqual,
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  WasmLocalScratchAllocator,
  wasmOpcode,
  wasmValueType,
  ExitReason,
  stateOffset,
  IR_ALU_FLAG_MASK,
  wasmBodyInstructions,
  wasmBodyMemoryAccesses,
  wasmBodyOpcodes,
  extractOnlyWasmFunctionBody,
  emitJitBlock,
  createJitValueCacheRuntime,
  buildTimeline,
  createJitState,
  exitState,
  const32,
  xorExpr,
  countOpcode,
  encodeJitBlock,
  type JitBlock,
} from "./value-local-store-test-helpers.js";
import { wasmMemoryIndex } from "#backends/wasm/abi.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import { planJitCodegen } from "#backends/wasm/jit/codegen/plan/plan.js";
import { rootPath } from "#backends/wasm/jit/analysis/paths.js";
import { jitProducedValue } from "#backends/wasm/jit/ir/values/builders.js";
import type { ValueRef } from "#x86/ir/model/types.js";

test("JIT production emission consumes planned effects from instruction plans", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const state = createJitState(body, [{ stores: [] }]);
  const expressionBlock = [
    { op: "hostTrap", vector: xorExpr(const32(0x15), const32(0x3f)) }
  ] as const;
  const instruction = {
    instructionId: "prebuilt-expression-block",
    eip: 0x1000,
    nextEip: 0x1001,
    nextMode: "continue",
    operands: [],
    ir: expressionBlock
  } as const;
  const initialState = exitState(0);
  const snapshot = exitState(1);
  const hostTrapExit = {
    id: "0:0:hostTrap",
    at: { instructionIndex: 0, opIndex: 0 },
    kind: "hostTrap",
    snapshot,
    visibleEip: { kind: "static", value: instruction.nextEip },
    reason: ExitReason.HOST_TRAP,
    payload: { kind: "runtime", source: "hostTrapVector" },
    path: rootPath(),
    exitMaterializationIndex: 0
  } as const;

  emitJitBlock({
    body,
    scratch,
    state,
    exit: { exitLocal, exitLabelDepth: 0 },
    instructions: [{
      instructionId: instruction.instructionId,
      eip: instruction.eip,
      nextEip: instruction.nextEip,
      nextMode: instruction.nextMode,
      instructionCountDelta: initialState.instructionCountDelta,
      initialValueState: initialState.valueState,
      paths: new Map(),
      exitCount: 1,
      operands: instruction.operands,
      expressionBlock,
      valueTimeline: buildTimeline({
        operands: [],
        expressions: expressionBlock,
        entry: initialState.valueState
      }),
      sourceExpressionMap: { placementsBySourceOpIndex: new Map() },
      expressionPaths: new Map(),
      producedByVar: new Map(),
      plannedValueCaptures: new Map()
    }],
    plannedEffects: [{
      placement: {
        instructionIndex: 0,
        opIndex: 0,
        epoch: 0
      },
      sourceOpIndex: 0,
      kind: "hostTrap",
      exit: hostTrapExit,
      valueRoots: []
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

test("JIT production emission does not walk unscheduled expression effects", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const state = createJitState(body, [{ stores: [] }]);
  const expressionBlock = [
    { op: "hostTrap", vector: xorExpr(const32(0x15), const32(0x3f)) }
  ] as const;
  const initialState = exitState(0);

  emitJitBlock({
    body,
    scratch,
    state,
    exit: { exitLocal, exitLabelDepth: 0 },
    instructions: [{
      instructionId: "unscheduled-expression-effect",
      eip: 0x1000,
      nextEip: 0x1001,
      nextMode: "continue",
      instructionCountDelta: initialState.instructionCountDelta,
      initialValueState: initialState.valueState,
      paths: new Map(),
      exitCount: 0,
      operands: [],
      expressionBlock,
      valueTimeline: buildTimeline({
        operands: [],
        expressions: expressionBlock,
        entry: initialState.valueState
      }),
      sourceExpressionMap: { placementsBySourceOpIndex: new Map() },
      expressionPaths: new Map(),
      producedByVar: new Map(),
      plannedValueCaptures: new Map()
    }],
    plannedEffects: []
  });
  scratch.assertClear();
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.br), 0);
});

test("JIT planned emission keeps a guard but skips an unused produced load", () => {
  const result = emitPlannedJitBlock(singleInstructionBlock([
    { op: "memory.guard", address: c32(0x60), byteLength: 4, access: "read" },
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c32(0x60) },
      accessWidth: 32
    },
    { op: "next" }
  ]));

  deepStrictEqual(result.emissionPlan.plannedEffects.map((effect) => effect.kind), [
    "memoryGuard",
    "producedValue",
    "fallthrough"
  ]);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.memorySize), 2);
  strictEqual(guestLoads(result).length, 0);
});

test("JIT planned emission keeps a dead produced-load guard before a later used load", () => {
  const result = emitPlannedJitBlock(singleInstructionBlock([
    { op: "memory.guard", address: c32(0x60), byteLength: 4, access: "read" },
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c32(0x60) },
      accessWidth: 32
    },
    { op: "memory.guard", address: c32(0x64), byteLength: 4, access: "read" },
    {
      op: "get",
      dst: v(1),
      source: { kind: "mem", address: c32(0x64) },
      accessWidth: 32
    },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: v(1), accessWidth: 32 },
    { op: "hostTrap", vector: c32(0x2e) }
  ]));

  deepStrictEqual(result.emissionPlan.plannedEffects.map((effect) => effect.kind), [
    "memoryGuard",
    "producedValue",
    "memoryGuard",
    "producedValue",
    "hostTrap"
  ]);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.memorySize), 4);
  strictEqual(guestLoads(result).length, 1);
  deepStrictEqual(result.emissionPlan.valueCachePlan.useCounts, [{
    value: jitProducedValue("load#planned-emission-test:0:3:1", "i32"),
    useCount: 1
  }]);
});

test("JIT planned emission captures a used produced load at its definition", () => {
  const result = emitPlannedJitBlock(singleInstructionBlock([
    { op: "memory.guard", address: c32(0x60), byteLength: 4, access: "read" },
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c32(0x60) },
      accessWidth: 32
    },
    { op: "hostTrap", vector: v(0) }
  ]));
  const loadIndex = result.instructions.findIndex((instruction) =>
    instruction.opcode === wasmOpcode.i32Load
  );
  const capture = result.instructions[loadIndex + 1];
  const laterUseIndex = result.instructions.findIndex((instruction, index) =>
    index > loadIndex + 1 &&
      instruction.opcode === wasmOpcode.localGet &&
      instruction.local === capture?.local
  );

  strictEqual(guestLoads(result).length, 1);
  strictEqual(capture?.opcode, wasmOpcode.localSet);
  strictEqual(laterUseIndex !== -1, true);
});

test("JIT planned emission skips unused arithmetic, register, and flag state", () => {
  const result = emitPlannedJitBlock(singleInstructionBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(1),
      a: v(0),
      b: c32(1)
    },
    { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 32 },
    {
      op: "flags.set",
      producer: "logic",
      writtenMask: IR_ALU_FLAG_MASK,
      undefMask: 0,
      inputs: { result: v(1) }
    }
  ], { nextMode: "continue" }));

  deepStrictEqual(result.emissionPlan.plannedEffects, []);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Add), 0);
  strictEqual(result.memoryAccesses.some((access) =>
    access.memoryIndex === wasmMemoryIndex.state &&
      (access.offset === stateOffset.ebx || access.offset === stateOffset.aluFlags)
  ), false);
});

test("JIT planned emission keeps memory store address before value", () => {
  const result = emitPlannedJitBlock(singleInstructionBlock([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(1),
      a: v(0),
      b: c32(1)
    },
    { op: "get", dst: v(2), source: { kind: "reg", reg: "ebx" }, accessWidth: 32 },
    {
      op: "value.binary",
      type: "i32",
      operator: "xor",
      dst: v(3),
      a: v(2),
      b: c32(2)
    },
    {
      op: "set",
      target: { kind: "mem", address: v(1) },
      value: v(3),
      accessWidth: 32
    }
  ], { nextMode: "continue" }));
  const addressIndex = result.opcodes.indexOf(wasmOpcode.i32Add);
  const valueIndex = result.opcodes.indexOf(wasmOpcode.i32Xor);
  const storeIndex = result.opcodes.indexOf(wasmOpcode.i32Store);

  deepStrictEqual(result.emissionPlan.plannedEffects.map((effect) => effect.kind), [
    "memoryStore"
  ]);
  strictEqual(addressIndex !== -1, true);
  strictEqual(valueIndex !== -1, true);
  strictEqual(storeIndex !== -1, true);
  strictEqual(addressIndex < valueIndex, true);
  strictEqual(valueIndex < storeIndex, true);
});

test("JIT codegen leaves dead pure SSA unpruned and emits no Wasm for it", () => {
  const block = singleInstructionBlock([
    { op: "value.const", type: "i32", dst: v(0), value: 1 },
    { op: "value.const", type: "i32", dst: v(1), value: 2 },
    {
      op: "value.binary",
      type: "i32",
      operator: "xor",
      dst: v(2),
      a: v(0),
      b: v(1)
    },
    { op: "next" }
  ]);
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));
  const opcodes = jitBlockOpcodes(block);

  deepStrictEqual(block.instructions[0]?.ir.map((op) => op.op), [
    "value.const",
    "value.const",
    "value.binary",
    "next"
  ]);
  deepStrictEqual(emissionPlan.plannedEffects.map((effect) => effect.kind), [
    "fallthrough"
  ]);
  deepStrictEqual(emissionPlan.plannedValueUses, []);
  deepStrictEqual(emissionPlan.valueCachePlan.useCounts, []);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.br), 1);
});

test("JIT codegen preserves guard-before-load ordering without pruning", () => {
  const block = singleInstructionBlock([
    { op: "value.const", type: "i32", dst: v(0), value: 0x1234 },
    { op: "memory.guard", address: c32(0x60), byteLength: 4, access: "read" },
    {
      op: "get",
      dst: v(1),
      source: { kind: "mem", address: c32(0x60) },
      accessWidth: 32
    },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(2),
      a: v(1),
      b: c32(1)
    },
    { op: "hostTrap", vector: v(2) }
  ]);
  const encoded = extractOnlyWasmFunctionBody(encodeJitBlock([block]));
  const opcodes = wasmBodyOpcodes(encoded);
  const accesses = wasmBodyMemoryAccesses(encoded);
  const firstGuardCheck = opcodes.indexOf(wasmOpcode.memorySize);
  const firstLoadAfterGuard = opcodes.indexOf(wasmOpcode.i32Load, firstGuardCheck);
  const guestLoads = accesses.filter((access) =>
    access.memoryIndex === wasmMemoryIndex.guest &&
      access.opcode === wasmOpcode.i32Load
  );

  strictEqual(firstGuardCheck !== -1, true);
  strictEqual(firstLoadAfterGuard !== -1, true);
  strictEqual(firstGuardCheck < firstLoadAfterGuard, true);
  strictEqual(guestLoads.length, 1);
});

function emitPlannedJitBlock(block: JitBlock) {
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const valueCache = createJitValueCacheRuntime(body, emissionPlan.valueCachePlan);
  const state = createJitState(body, emissionPlan.exitMaterializations, { valueCache });
  const exit = { exitLocal, exitLabelDepth: state.maxExitMaterializationIndex };

  state.emitLoadInstructionCount();

  for (let index = 0; index <= state.maxExitMaterializationIndex; index += 1) {
    body.block();
  }

  emitJitBlock({
    body,
    scratch,
    state,
    exit,
    instructions: emissionPlan.instructions,
    plannedEffects: emissionPlan.plannedEffects,
    valueCache
  });

  for (let index = state.maxExitMaterializationIndex; index >= 0; index -= 1) {
    body.endBlock();
    state.emitExitMaterializationStores(index);
    state.releaseExitMaterialization(index);
    body.localGet(exitLocal).returnFromFunction();
  }

  scratch.assertClear();
  body.end();

  const encoded = body.encode();

  return {
    emissionPlan,
    instructions: wasmBodyInstructions(encoded),
    memoryAccesses: wasmBodyMemoryAccesses(encoded),
    opcodes: wasmBodyOpcodes(encoded)
  };
}

function singleInstructionBlock(
  ir: JitBlock["instructions"][number]["ir"],
  options: Readonly<{ nextMode?: "continue" | "exit" }> = {}
): JitBlock {
  return {
    instructions: [{
      instructionId: "planned-emission-test",
      eip: 0x1000,
      nextEip: 0x1001,
      nextMode: options.nextMode ?? "exit",
      operands: [],
      ir
    }]
  };
}

function v(id: number): Extract<ValueRef, { kind: "var" }> {
  return { kind: "var", id };
}

function c32(value: number): Extract<ValueRef, { kind: "const" }> {
  return { kind: "const", type: "i32", value };
}

function guestLoads(result: ReturnType<typeof emitPlannedJitBlock>) {
  return result.memoryAccesses.filter((access) =>
    access.memoryIndex === wasmMemoryIndex.guest &&
      access.opcode === wasmOpcode.i32Load
  );
}

function jitBlockOpcodes(block: JitBlock): readonly number[] {
  return wasmBodyOpcodes(extractOnlyWasmFunctionBody(encodeJitBlock([block])));
}
