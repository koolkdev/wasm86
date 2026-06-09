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
  wasmBodyInstructions,
  wasmBodyMemoryAccesses,
  wasmBodyOpcodes,
  extractOnlyWasmFunctionBody,
  createValueCache,
  createValueEmittersForCache,
  valueCacheState,
  createExitMetadataEmitter,
  createExitStoreEmitter,
  createExitStoreLayout,
  exitState,
  countOpcode,
  passthroughValueCache,
  encodeJitBlock,
  bindTestJitBlock,
  type JitIrBlock,
  type JitValue
} from "./value-local-store-test-helpers.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import {
  buildBlockExpressions,
  planJitCodegen
} from "#backends/wasm/jit/block.js";
import { rootPath } from "#backends/wasm/jit/analysis/paths.js";
import { jitLoadResultValue } from "#backends/wasm/jit/ir/values/builders.js";
import type { ValueRef } from "#ir/model/types.js";
import { createScheduleEmitter } from "#backends/wasm/jit/codegen/emit/schedule.js";
import { createExitFrame } from "#backends/wasm/jit/codegen/emit/exit-frame.js";
import type { CapturePlan } from "#backends/wasm/jit/codegen/plan/captures.js";
import type { BlockSchedule } from "#backends/wasm/jit/codegen/plan/schedule-types.js";
import type { ValueCacheState } from "#backends/wasm/jit/codegen/emit/cache.js";

test("JIT production emission consumes block schedule entries", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const metadata = createExitMetadataEmitter(body);
  const valueCache = passthroughValueCache();
  const stores = createExitStoreEmitter({ body });
  const vector = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: { kind: "const", type: "i32", value: 0x15 },
    b: { kind: "const", type: "i32", value: 0x3f }
  } as const satisfies JitValue;
  const snapshot = exitState(1);
  const hostTrapExit = {
    id: "0:hostTrap",
    at: { opIndex: 0 },
    kind: "hostTrap",
    snapshot,
    visibleEip: { kind: "static", value: 0x1001 },
    reason: ExitReason.HOST_TRAP,
    payload: { kind: "runtime", source: "hostTrapVector" },
    path: rootPath(),
    stores: [],
    exitStoreIndex: 0
  } as const;
  const exitStoreLayout = createExitStoreLayout({
    exits: [{ exit: hostTrapExit, stores: [] }],
    exitStoreSets: [{ stores: [] }],
    maxExitStoreIndex: 0
  });

  emitScheduleBlock({
    body,
    scratch,
    metadata,
    stores,
    exitStoreLayout,
    exitLocal,
    captures: emptyCapturePlan(),
    valueState: valueCacheState(valueCache),
    schedule: [{
      at: {
        opIndex: 0,
        epoch: 0
      },
      kind: "hostTrap",
      vector,
      exit: hostTrapExit
    }]
  });
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

test("JIT production emission does not walk unscheduled expression actions", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const metadata = createExitMetadataEmitter(body);
  const valueCache = passthroughValueCache();
  const stores = createExitStoreEmitter({ body });
  const exitStoreLayout = createExitStoreLayout({
    exits: [],
    exitStoreSets: [{ stores: [] }],
    maxExitStoreIndex: 0
  });

  emitScheduleBlock({
    body,
    scratch,
    metadata,
    stores,
    exitStoreLayout,
    exitLocal,
    captures: emptyCapturePlan(),
    valueState: valueCacheState(valueCache),
    schedule: []
  });
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.br), 0);
});

test("JIT schedule emission keeps a guard but skips an unused load-result load", () => {
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

  deepStrictEqual(result.emissionPlan.schedule.map((entry) => entry.kind), [
    "memoryGuard",
    "defineLoadResult",
    "fallthrough"
  ]);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.memorySize), 2);
  strictEqual(guestLoads(result).length, 0);
});

test("JIT schedule emission keeps a dead load-result guard before a later used load", () => {
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

  deepStrictEqual(result.emissionPlan.schedule.map((entry) => entry.kind), [
    "memoryGuard",
    "defineLoadResult",
    "memoryGuard",
    "defineLoadResult",
    "hostTrap"
  ]);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.memorySize), 4);
  strictEqual(guestLoads(result).length, 1);
  deepStrictEqual(result.emissionPlan.reusePlan.cache.selected, [{
    value: jitLoadResultValue(1, "i32"),
    useCount: 1
  }]);
});

test("JIT schedule emission captures a used memory-load value at its placement", () => {
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

test("JIT schedule emission can use an earlier load result as a later load address", () => {
  const result = emitPlannedJitBlock(singleInstructionBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c32(0x60) },
      accessWidth: 32
    },
    {
      op: "get",
      dst: v(1),
      source: { kind: "mem", address: v(0) },
      accessWidth: 32
    },
    { op: "hostTrap", vector: v(1) }
  ]));

  deepStrictEqual(result.emissionPlan.reusePlan.cache.selected, [
    { value: jitLoadResultValue(1, "i32"), useCount: 1 },
    { value: jitLoadResultValue(0, "i32"), useCount: 1 }
  ]);
  strictEqual(guestLoads(result).length, 2);
});

test("JIT schedule emission keeps unused chained memory-load values inert", () => {
  const result = emitPlannedJitBlock(singleInstructionBlock([
    {
      op: "get",
      dst: v(0),
      source: { kind: "mem", address: c32(0x60) },
      accessWidth: 32
    },
    {
      op: "get",
      dst: v(1),
      source: { kind: "mem", address: v(0) },
      accessWidth: 32
    },
    { op: "next" }
  ]));

  deepStrictEqual(result.emissionPlan.reusePlan.cache.selected, []);
  strictEqual(guestLoads(result).length, 0);
});

test("JIT schedule emission skips unused arithmetic, register, and flag state", () => {
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
      op: "flags.write",
      cells: {
        CF: { kind: "expr", value: v(1) },
        PF: { kind: "expr", value: v(1) },
        AF: { kind: "expr", value: v(1) },
        ZF: { kind: "expr", value: v(1) },
        SF: { kind: "expr", value: v(1) },
        OF: { kind: "expr", value: v(1) }
      }
    }
  ], { nextMode: "continue" }));

  deepStrictEqual(result.emissionPlan.schedule, []);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Add), 0);
  strictEqual(result.memoryAccesses.some((access) =>
    access.memoryIndex === wasmMemoryIndex.state &&
      (access.offset === stateOffset.ebx || access.offset === stateOffset.aluFlags)
  ), false);
});

test("JIT schedule emission keeps memory store address before value", () => {
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

  deepStrictEqual(result.emissionPlan.schedule.map((entry) => entry.kind), [
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
  const emissionPlan = buildJitCodegenEmissionPlan(planBlock(block));
  const opcodes = jitBlockOpcodes(block);

  deepStrictEqual(block.instructions[0]?.ir.map((op) => op.op), [
    "value.const",
    "value.const",
    "value.binary",
    "next"
  ]);
  deepStrictEqual(emissionPlan.schedule.map((entry) => entry.kind), [
    "fallthrough"
  ]);
  deepStrictEqual(emissionPlan.valueUses, []);
  deepStrictEqual(emissionPlan.reusePlan.cache.selected, []);
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

function emitPlannedJitBlock(block: JitIrBlock) {
  const emissionPlan = buildJitCodegenEmissionPlan(planBlock(block));
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const valueState = createValueCache(
    body,
    emissionPlan.reusePlan.cache,
    emissionPlan.reusePlan.block
  );
  const metadata = createExitMetadataEmitter(body);
  const stores = createExitStoreEmitter({ body });
  const exitStoreLayout = createExitStoreLayout(emissionPlan.storeStrategy);

  emitScheduleBlock({
    body,
    scratch,
    metadata,
    stores,
    exitStoreLayout,
    exitLocal,
    captures: emissionPlan.reusePlan.captures,
    schedule: emissionPlan.schedule,
    valueState
  });

  body.end();

  const encoded = body.encode();

  return {
    emissionPlan,
    instructions: wasmBodyInstructions(encoded),
    memoryAccesses: wasmBodyMemoryAccesses(encoded),
    opcodes: wasmBodyOpcodes(encoded)
  };
}

type ScheduleBlockInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  metadata: ReturnType<typeof createExitMetadataEmitter>;
  stores: ReturnType<typeof createExitStoreEmitter>;
  exitStoreLayout: ReturnType<typeof createExitStoreLayout>;
  exitLocal: number;
  captures: CapturePlan;
  schedule: BlockSchedule;
  valueState: ValueCacheState;
}>;

function emitScheduleBlock(input: ScheduleBlockInput): void {
  const values = createValueEmittersForCache(input.body, input.valueState);
  const exitFrame = createExitFrame({
    body: input.body,
    metadata: input.metadata,
    stores: input.stores,
    layout: input.exitStoreLayout,
    exitLocal: input.exitLocal
  });

  input.metadata.beginBlock();
  exitFrame.openDeferredBlocks();

  const schedule = createScheduleEmitter({
    body: input.body,
    scratch: input.scratch,
    exitFrame,
    captures: input.captures,
    values
  });

  for (const entry of input.schedule) {
    schedule.emit(entry);
  }

  input.scratch.assertClear();
  exitFrame.emitDeferredReturns();
  input.scratch.assertClear();
}

function emptyCapturePlan(): CapturePlan {
  return {
    captures: [],
    runtimeCaptures: new Map()
  };
}

function singleInstructionBlock(
  ir: JitIrBlock["instructions"][number]["ir"],
  _options: Readonly<{ nextMode?: "continue" | "exit" }> = {}
): JitIrBlock {
  return {
    instructions: [{
      instructionId: "planned-emission-test",
      eip: 0x1000,
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

function jitBlockOpcodes(block: JitIrBlock): readonly number[] {
  return wasmBodyOpcodes(extractOnlyWasmFunctionBody(encodeJitBlock([block])));
}

function planBlock(block: JitIrBlock) {
  return planJitCodegen(buildBlockExpressions(bindTestJitBlock(block)));
}
