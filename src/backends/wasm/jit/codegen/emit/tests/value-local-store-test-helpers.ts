import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#wasm/encoder/types.js";
import { ExitReason } from "#wasm/exit.js";
import { stateOffset } from "#wasm/abi.js";
import { ok, decodeBytes, startAddress } from "#x86/decoder/tests/helpers.js";
import { cleanValueWidth, type ValueWidth } from "#wasm/codegen/value-width.js";
import type {
  IrExprBlock,
  IrStorageExpr,
  IrValueExpr
} from "#wasm/codegen/expressions.js";
import { IR_ALU_FLAG_MASK } from "#ir/model/flag-effects.js";
import {
  extractOnlyWasmFunctionBody,
  wasmBodyMemoryAccesses,
  wasmBodyLocalCount,
  wasmBodyInstructions,
  wasmBodyOpcodes
} from "#wasm/tests/body-opcodes.js";
import {
  jitInputAluFlagsValue,
  jitInputReg32Value
} from "#backends/wasm/jit/ir/values/builders.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  LocalStore,
  type CapturedValue
} from "#backends/wasm/jit/codegen/emit/local-store.js";
import {
  createValueCache,
  type ValueCache,
  type ValueCacheState,
  type ValueScope
} from "#backends/wasm/jit/codegen/emit/cache.js";
import { createInputSlotEmitter } from "#backends/wasm/jit/codegen/emit/input-slots.js";
import {
  createValueEmitters,
  unavailableLoadResultEmitter,
  type ValueEmitters
} from "#backends/wasm/jit/codegen/emit/values.js";
import {
  captureExitStores,
  createExitStoreEmitter,
  emitExitStores,
  releaseExitStores
} from "#backends/wasm/jit/codegen/emit/exit-stores.js";
import { createExitMetadataEmitter } from "#backends/wasm/jit/codegen/emit/exit-metadata.js";
import { createExitStoreLayout } from "#backends/wasm/jit/codegen/emit/exit-frame.js";
import {
  buildBlock,
  buildBlockExpressions,
  encodeJitBlock as encodeJitPlans,
  planJitCodegen,
  validateBlock,
  type EncodeJitBlockOptions
} from "#backends/wasm/jit/block.js";
import type {
  JitIrBlock as BoundJitIrBlock,
  JitIrInstruction
} from "#backends/wasm/jit/ir/types.js";
import type { IrOp, StorageRef, ValueRef } from "#ir/model/types.js";
import {
  planReuseForBlock,
  type BlockEpochSource
} from "#backends/wasm/jit/codegen/plan/reuse.js";
import type { Capture } from "#backends/wasm/jit/codegen/plan/captures.js";
import { LoadResultRegistry } from "#backends/wasm/jit/analysis/load-result.js";
import { buildTimeline as buildTimelineWithRegistry } from "#backends/wasm/jit/analysis/timeline-builder.js";
import type { TimelineInput } from "#backends/wasm/jit/analysis/timeline-types.js";
import {
  blockExpressionsForTest,
  valueUsesForExpressionBlock
} from "#backends/wasm/jit/codegen/tests/value-use-test-helpers.js";
import {
  branchPath,
  rootPath
} from "#backends/wasm/jit/analysis/paths.js";
import type { ExitSnapshot } from "#backends/wasm/jit/analysis/exits.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import type { Reg32 } from "#x86/types.js";

type TestJitIrInstruction =
  Omit<JitIrInstruction, "nextEip"> &
  Partial<Pick<JitIrInstruction, "nextEip">>;

export type JitIrBlock = Readonly<{
  instructions: readonly TestJitIrInstruction[];
}>;

type TestTimelineInput = Omit<TimelineInput, "expressions" | "loadResultRegistry"> & Readonly<{
  expressions: IrExprBlock;
}>;

function buildTimeline(input: TestTimelineInput) {
  const { expressions, ...rest } = input;

  return buildTimelineWithRegistry({
    ...rest,
    expressions: blockExpressionsForTest(expressions),
    loadResultRegistry: new LoadResultRegistry()
  });
}

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
  jitInputReg32Value,
  createValueCache,
  LocalStore,
  captureExitStores,
  createExitMetadataEmitter,
  createExitStoreEmitter,
  createExitStoreLayout,
  emitExitStores,
  releaseExitStores,
  buildBlock,
  buildTimeline,
  branchPath,
  rootPath,
  createJitValueState
};
export type {
  ValueWidth,
  IrStorageExpr,
  IrValueExpr,
  JitValue,
  ValueCache,
  ValueCacheState,
  ValueScope,
  ValueEmitters,
  ExitSnapshot,
  Reg32
};

export function encodeJitBlock(
  blocks: readonly JitIrBlock[],
  options?: EncodeJitBlockOptions
): Uint8Array<ArrayBuffer> {
  const boundBlocks = blocks.map(bindTestJitBlock);

  boundBlocks.forEach(validateBlock);

  return encodeJitPlans(
    boundBlocks.map((block) => ({
      entryEip: requiredEntryEip(block),
      plan: planJitCodegen(buildBlockExpressions(block))
    })),
    options
  );
}

function requiredEntryEip(block: BoundJitIrBlock): number {
  const firstInstruction = block.instructions[0];

  if (firstInstruction === undefined) {
    throw new Error("cannot encode empty JIT test block");
  }

  return firstInstruction.eip;
}

export function bindTestJitBlock(block: JitIrBlock): BoundJitIrBlock {
  return {
    instructions: block.instructions.map((instruction): JitIrInstruction => {
      const nextEip = instruction.nextEip ?? instruction.eip + 1;

      return {
        ...instruction,
        nextEip,
        ir: bindTestInstructionIr(instruction.ir, nextEip)
      };
    })
  };
}

function bindTestInstructionIr(ir: readonly IrOp[], nextEip: number): readonly IrOp[] {
  return ir.map((op) => bindTestInstructionOp(op, nextEip));
}

function bindTestInstructionOp(op: IrOp, nextEip: number): IrOp {
  switch (op.op) {
    case "get":
      return { ...op, source: bindTestStorage(op.source, nextEip) };
    case "set":
      return { ...op, target: bindTestStorage(op.target, nextEip), value: bindTestValue(op.value, nextEip) };
    case "memory.guard":
      return { ...op, address: bindTestValue(op.address, nextEip) };
    case "value.binary":
      return { ...op, a: bindTestValue(op.a, nextEip), b: bindTestValue(op.b, nextEip) };
    case "value.unary":
      return { ...op, value: bindTestValue(op.value, nextEip) };
    case "value.select":
      return {
        ...op,
        condition: bindTestValue(op.condition, nextEip),
        whenTrue: bindTestValue(op.whenTrue, nextEip),
        whenFalse: bindTestValue(op.whenFalse, nextEip)
      };
    case "value.project":
      return { ...op, value: bindTestValue(op.value, nextEip) };
    case "value.compare":
      return { ...op, a: bindTestValue(op.a, nextEip), b: bindTestValue(op.b, nextEip) };
    case "flags.write":
      return {
        ...op,
        cells: Object.fromEntries(
          Object.entries(op.cells).map(([flag, cell]) => [
            flag,
            cell?.kind === "expr" ? { kind: "expr", value: bindTestValue(cell.value, nextEip) } : cell
          ])
        ),
        ...(op.conditions === undefined
          ? {}
          : {
              conditions: Object.fromEntries(
                Object.entries(op.conditions).map(([cc, value]) => [cc, bindTestValue(value, nextEip)])
              )
            })
      };
    case "next":
      return op;
    case "jump":
      return { ...op, target: bindTestValue(op.target, nextEip) };
    case "conditionalJump":
      return {
        ...op,
        condition: bindTestValue(op.condition, nextEip),
        taken: bindTestValue(op.taken, nextEip),
        notTaken: bindTestValue(op.notTaken, nextEip)
      };
    case "hostTrap":
      return { ...op, vector: bindTestValue(op.vector, nextEip) };
    case "address":
    case "value.const":
    case "flags.condition":
      return op;
  }
}

function bindTestStorage(storage: StorageRef, nextEip: number): StorageRef {
  return storage.kind === "mem"
    ? { kind: "mem", address: bindTestValue(storage.address, nextEip) }
    : storage;
}

function bindTestValue(value: ValueRef, nextEip: number): ValueRef {
  return value.kind === "nextEip" ? constValueRef(nextEip) : value;
}

function constValueRef(value: number): Extract<ValueRef, { kind: "const" }> {
  return { kind: "const", type: "i32", value };
}

export function addValue(reg: "eax" | "ebx", value: number): JitValue {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: jitInputReg32Value(reg),
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
    b: jitInputReg32Value("edx")
  };
}

export function planReuseForBlockTest(
  block: BlockEpochSource,
  expressionBlock: IrExprBlock
) {
  const valueUses = valueUsesForExpressionBlock({
    expressionBlock,
    valueTimeline: block.valueTimeline
  });

  return planReuseForBlock(
    { ...block, expressions: blockExpressionsForTest(expressionBlock) },
    valueUses,
    []
  );
}

export function cacheRuntimeForStore(store: LocalStore): ValueCache & ValueScope {
  return {
    withPath: (path, emit) => store.withPath(path, emit),
    emitForUse: (_at, value, emitter) => emitWithLocalStore(store, value, emitter),
    retain: (value) => store.retainAvailable(value),
    capture: (capture, emitter) => captureWithLocalStore(store, capture.value, emitter),
    define: (_at, value, emitter) => captureWithLocalStore(store, value, emitter),
    canInline: () => true
  };
}

export function valueCacheState(
  cacheAndScope: ValueCache & ValueScope
): ValueCacheState {
  return {
    cache: cacheAndScope,
    scope: cacheAndScope
  };
}

export function passthroughValueCache(
  overrides: Partial<ValueCache & ValueScope> = {}
): ValueCache & ValueScope {
  return {
    withPath: (_path, emit) => emit(),
    emitForUse: (_at, _value, emitter) => ({ valueWidth: emitter() }),
    retain: () => undefined,
    capture: () => {
      throw new Error("unexpected value cache capture");
    },
    define: () => undefined,
    canInline: () => true,
    ...overrides
  };
}

export function emitWithLocalStore(
  store: LocalStore,
  value: JitValue,
  emitter: () => ValueWidth
): ReturnType<LocalStore["tee"]> {
  const available = store.get(value);

  if (available !== undefined) {
    return available;
  }

  return store.tee(value, emitter());
}

export function captureWithLocalStore(
  store: LocalStore,
  value: JitValue,
  emitter: () => ValueWidth
): CapturedValue {
  const available = store.retainAvailable(value);

  if (available !== undefined) {
    return available;
  }

  return store.set(value, emitter());
}

export function createValueEmittersForCache(
  body: WasmFunctionBodyEncoder,
  valueState: ValueCacheState | (ValueCache & ValueScope)
): ValueEmitters {
  const state = "cache" in valueState
    ? valueState
    : valueCacheState(valueState);

  return createValueEmitters({
    body,
    cache: state.cache,
    scope: state.scope,
    inputs: createInputSlotEmitter(body),
    loadResults: unavailableLoadResultEmitter()
  });
}

export function createOneOpValueCache(
  body: WasmFunctionBodyEncoder
): ValueCacheState {
  return createValueCache(
    body,
    { epochs: [{ index: 0, consumers: [] }], selected: [] },
    { valueTimeline: undefined as never, opEpochs: [0] }
  );
}

export function createOneOpSelectedValueCache(
  body: WasmFunctionBodyEncoder,
  value: JitValue
): ValueCacheState {
  const selected = { value, useCount: 1 };
  return createValueCache(
    body,
    { epochs: [{ index: 0, consumers: [selected] }], selected: [selected] },
    { valueTimeline: undefined as never, opEpochs: [0] }
  );
}

export function oneOpPlacement(): Capture["at"] {
  return { opIndex: 0, epoch: 0 };
}

export function forcedRootCapture(value: JitValue): Capture {
  return {
    value,
    at: oneOpPlacement(),
    availability: rootPath(),
    consumers: [],
    reason: "forced"
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

export function exitState(
  instructionCountDelta: number
): ExitSnapshot {
  return {
    progress: {
      instructionCountDelta
    },
    valueState: createJitValueState().snapshot()
  };
}

export function repeatedInlineExpressionBlock(): JitIrBlock {
  return {
    instructions: [{
      instructionId: "cache-test",
      eip: 0x1000,
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
