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
  emitJitBlock,
  createJitValueCacheRuntime,
  buildJitInstructionValueTimeline,
  createJitIrState,
  exitState,
  const32,
  xorExpr,
  countOpcode,
  type JitIrBlock,
} from "./value-local-store-test-helpers.js";
import { wasmMemoryIndex } from "#backends/wasm/abi.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import { planJitCodegen } from "#backends/wasm/jit/codegen/plan/plan.js";
import { rootValuePathScope } from "#backends/wasm/jit/codegen/plan/control-paths.js";
import type { ValueRef } from "#x86/ir/model/types.js";

test("JIT emission consumes prebuilt expression blocks from instruction plans", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const state = createJitIrState(body, [{ stores: [] }]);
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
  const observedState = exitState(1);

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
      controlPathScopes: new Map(),
      exitPointCount: 1,
      operands: instruction.operands,
      expressionBlock,
      valueTimeline: buildJitInstructionValueTimeline({
        operands: [],
        expressionBlock,
        entryValueState: initialState.valueState
      }),
      sourceExpressionMap: { placementsBySourceOpIndex: new Map() },
      expressionPathScopes: new Map(),
      producedValuesByVarId: new Map(),
      plannedValueCaptures: new Map()
    }],
    exitPoints: [{
      instructionIndex: 0,
      opIndex: 0,
      observedState,
      visibleEip: { kind: "static", value: instruction.nextEip },
      exitReason: ExitReason.HOST_TRAP,
      payload: { kind: "runtime", source: "hostTrapVector" },
      pathScope: rootValuePathScope(),
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
    "producedValueDefinition",
    "exitEdge"
  ]);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.memorySize), 2);
  strictEqual(guestLoads(result).length, 0);
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

test("JIT planned emission skips unused arithmetic, register, and flag facts", () => {
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

function emitPlannedJitBlock(block: JitIrBlock) {
  const emissionPlan = buildJitCodegenEmissionPlan(planJitCodegen(block));
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const valueCache = createJitValueCacheRuntime(body, emissionPlan.valueCachePlan);
  const state = createJitIrState(body, emissionPlan.exitMaterializations, { valueCache });
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
    exitPoints: emissionPlan.exitPoints,
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
  ir: JitIrBlock["instructions"][number]["ir"],
  options: Readonly<{ nextMode?: "continue" | "exit" }> = {}
): JitIrBlock {
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
