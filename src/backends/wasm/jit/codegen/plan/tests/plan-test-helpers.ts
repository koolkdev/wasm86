import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/decoder/tests/helpers.js";
import type { Reg32 } from "#x86/types.js";
import { IR_ALU_FLAG_MASK } from "#ir/model/flag-effects.js";
import { ExitReason } from "#wasm/exit.js";
import type { IrExprBlock, IrValueExpr } from "#wasm/codegen/expressions.js";
import { buildBlock } from "#backends/wasm/jit/block.js";
import {
  analyzeBlock,
  buildBlockExpressions
} from "#backends/wasm/jit/block.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import {
  planJitCodegen as planExpressionCodegen
} from "#backends/wasm/jit/codegen/plan/plan.js";
import {
  branchPath,
  rootPath
} from "#backends/wasm/jit/analysis/paths.js";
import { planReuseForBlock } from "#backends/wasm/jit/codegen/plan/reuse.js";
import { LoadResultRegistry } from "#backends/wasm/jit/analysis/load-result.js";
import { buildTimeline as buildTimelineWithRegistry } from "#backends/wasm/jit/analysis/timeline-builder.js";
import type { TimelineInput } from "#backends/wasm/jit/analysis/timeline-types.js";
import type { IrOp, StorageRef, ValueRef } from "#ir/model/types.js";
import {
  type UsePurpose
} from "#backends/wasm/jit/codegen/plan/value-uses.js";
import type {
  Exit,
  ExitSnapshot,
  ExitPayload,
  ExitValue
} from "#backends/wasm/jit/analysis/exits.js";
import {
  blockExpressionsForTest,
  valueUsesForExpressionBlock,
  type TestValueRoot
} from "#backends/wasm/jit/codegen/tests/value-use-test-helpers.js";
import type {
  JitCodegenPlan,
  ExitStore,
  PlannedExitStore,
  PlannedExit
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  jitExtractBits,
  jitFlagConditionValue,
  jitFlagWriteValue,
  jitInputAluFlagsValue,
  jitInputReg16Value,
  jitInputReg32Value,
  jitInputReg8Value,
  jitInsertMaskedBits,
  jitLoadResultValue
} from "#backends/wasm/jit/ir/values/builders.js";
import type {
  JitLoadResultValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type {
  JitIrBlock as BoundJitIrBlock,
  JitIrInstruction
} from "#backends/wasm/jit/ir/types.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";

export const startAddress = 0x1000;

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
  throws,
  test,
  ok,
  decodeBytes,
  IR_ALU_FLAG_MASK,
  ExitReason,
  buildBlock,
  analyzeBlock,
  buildBlockExpressions,
  buildJitCodegenEmissionPlan,
  blockExpressionsForTest,
  branchPath,
  rootPath,
  planReuseForBlock,
  buildTimeline,
  jitExtractBits,
  jitFlagConditionValue,
  jitFlagWriteValue,
  jitInputAluFlagsValue,
  jitInputReg16Value,
  jitInputReg32Value,
  jitInputReg8Value,
  jitInsertMaskedBits,
  jitLoadResultValue,
  createJitValueState
};
export type {
  Reg32,
  IrExprBlock,
  IrValueExpr,
  JitCodegenPlan,
  ExitStore,
  PlannedExitStore,
  PlannedExit,
  Exit,
  ExitSnapshot,
  ExitPayload,
  ExitValue,
  JitLoadResultValue,
  JitValue
};

export function analyzeBlockForTest(block: JitIrBlock) {
  return analyzeBlock(buildBlockExpressions(bindTestJitBlock(block)));
}

export function planJitCodegen(block: JitIrBlock): JitCodegenPlan {
  return planExpressionCodegen(buildBlockExpressions(bindTestJitBlock(block)));
}

export function onlyExit(exits: readonly PlannedExit[], reason: ExitReason): PlannedExit {
  const matches = exits.filter((entry) => entry.reason === reason);

  strictEqual(matches.length, 1);
  return matches[0]!;
}

export function planValueCacheForTest(input: Readonly<{
  expressionBlock: IrExprBlock;
  extraUses?: ReadonlyMap<number, readonly TestValueRoot[]>;
}>) {
  const valueTimeline = buildTimeline({
    expressions: input.expressionBlock,
    snapshotPoints: new Set()
  });
  const valueUses = valueUsesForExpressionBlock({
    expressionBlock: input.expressionBlock,
    valueTimeline,
    extraUses: input.extraUses ?? new Map()
  });

  return planReuseForBlock({
    expressions: blockExpressionsForTest(input.expressionBlock),
    valueTimeline
  }, valueUses, []);
}

function bindTestJitBlock(block: JitIrBlock): BoundJitIrBlock {
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
    ? { kind: "mem" as const, address: bindTestValue(storage.address, nextEip) }
    : storage;
}

function bindTestValue(value: ValueRef, nextEip: number): ValueRef {
  return value.kind === "nextEip" ? c32Expr(nextEip) : value;
}

export function extraUse(
  value: JitValue,
  purpose: UsePurpose = "exitStore"
): TestValueRoot {
  return {
    value,
    path: rootPath(),
    purpose
  };
}

export function registerStore(reg: Reg32, value: JitValue = jitInputReg32Value(reg)): ExitStore {
  return {
    target: { kind: "reg32", reg },
    value
  };
}

export function flagStore(value: JitValue): ExitStore {
  return {
    target: { kind: "aluFlags" },
    value
  };
}

export function inlineStore(store: ExitStore): PlannedExitStore {
  return {
    store,
    source: { kind: "inline" }
  };
}

export function plannedStoreSources(
  stores: readonly PlannedExitStore[]
): readonly (readonly [ExitStore, PlannedExitStore["source"]["kind"]])[] {
  return stores.map((store) => [store.store, store.source.kind]);
}

export function plannedRegisterStores(exit: PlannedExit): readonly ExitStore[] {
  return exit.stores.filter((store) =>
    store.target.kind === "reg32" || store.target.kind === "reg16" || store.target.kind === "reg8"
  ).map(({ target, value }) => ({ target, value }));
}

export function plannedFlagStores(exit: PlannedExit): readonly ExitStore[] {
  return exit.stores
    .filter((store) => store.target.kind === "aluFlags")
    .map(({ target, value }) => ({ target, value }));
}

export function exitPoint(input: Readonly<{
  opIndex: number;
  kind?: PlannedExit["kind"];
  reason: ExitReason;
  snapshot: ExitSnapshot;
  stores?: readonly ExitStore[];
  exitStoreIndex: number;
  visibleEip?: ExitValue;
  payload?: ExitPayload;
  path?: PlannedExit["path"];
}>): PlannedExit {
  const visibleEip = input.visibleEip ?? { kind: "static", value: 0 };
  const kind = input.kind ?? exitKind(input.reason, input.path);
  const at = { opIndex: input.opIndex };

  return {
    id: `${at.opIndex}:${kind}`,
    at,
    kind,
    snapshot: input.snapshot,
    visibleEip,
    reason: input.reason,
    payload: input.payload ?? visibleEip,
    path: input.path ?? rootPath(),
    stores: input.stores ?? [],
    exitStoreIndex: input.exitStoreIndex
  };
}

function exitKind(reason: ExitReason, path: PlannedExit["path"] | undefined): PlannedExit["kind"] {
  switch (reason) {
    case ExitReason.MEMORY_READ_FAULT:
      return "memoryReadFault";
    case ExitReason.MEMORY_WRITE_FAULT:
      return "memoryWriteFault";
    case ExitReason.FALLTHROUGH:
      return "fallthrough";
    case ExitReason.HOST_TRAP:
      return "hostTrap";
    case ExitReason.JUMP:
      if (path?.debugLabel === "taken") {
        return "branchTaken";
      }

      if (path?.debugLabel === "notTaken") {
        return "branchNotTaken";
      }

      return "jump";
    default:
      throw new Error(`unsupported planned-exit test reason: ${reason}`);
  }
}

export function exitState(
  instructionCountDelta: number,
  changedRegs: readonly Reg32[] = []
): ExitSnapshot {
  const valueState = createJitValueState();

  for (const reg of changedRegs) {
    valueState.regs.writeReg32(reg, jitInputReg32Value(reg));
  }

  return {
    progress: {
      instructionCountDelta
    },
    valueState: valueState.snapshot()
  };
}

export function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

export function c32Expr(value: number): Extract<IrValueExpr, { kind: "const" }> {
  return { kind: "const", type: "i32", value };
}

export function sourceRegExpr(reg: Reg32): IrValueExpr {
  return { kind: "source", source: { kind: "reg", reg }, accessWidth: 32 };
}

export function addExpr(reg: Reg32, value: number): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: sourceRegExpr(reg),
    b: c32Expr(value)
  };
}

export function addValue(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

export function subValue(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "sub", a, b };
}
