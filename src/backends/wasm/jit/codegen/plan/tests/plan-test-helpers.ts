import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import type { Reg32 } from "#x86/isa/types.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import { ExitReason } from "#backends/wasm/exit.js";
import type { IrExprBlock, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { buildBlock } from "#backends/wasm/jit/block.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import {
  planJitCodegen
} from "#backends/wasm/jit/codegen/plan/plan.js";
import {
  branchPath,
  rootPath
} from "#backends/wasm/jit/analysis/paths.js";
import { planJitValueCacheForInstructions } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { buildTimeline } from "#backends/wasm/jit/analysis/timeline.js";
import {
  planJitValueUses,
  type JitValueUseRoot
} from "#backends/wasm/jit/codegen/plan/value-uses.js";
import { rootExpressionPaths } from "#backends/wasm/jit/codegen/tests/path-test-helpers.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type {
  JitCodegenPlan,
  ExitStore,
  PlannedExitStore,
  PlannedExit,
  ExitSnapshot,
  JitInstructionState,
  JitExitStoreUse,
  ExitPayload,
  ExitValue
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  jitExtractBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg16Value,
  jitInputReg32Value,
  jitInputReg8Value,
  jitInsertMaskedBits,
  jitProducedValue
} from "#backends/wasm/jit/ir/values/builders.js";
import type {
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { JitBlock } from "#backends/wasm/jit/ir/types.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";

export const startAddress = 0x1000;

export {
  deepStrictEqual,
  strictEqual,
  throws,
  test,
  ok,
  decodeBytes,
  IR_ALU_FLAG_MASK,
  FLAG_PRODUCERS,
  ExitReason,
  buildBlock,
  buildJitCodegenEmissionPlan,
  planJitCodegen,
  branchPath,
  rootPath,
  planJitValueCacheForInstructions,
  buildTimeline,
  jitExtractBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg16Value,
  jitInputReg32Value,
  jitInputReg8Value,
  jitInsertMaskedBits,
  jitProducedValue,
  createJitValueState
};
export type {
  Reg32,
  IrExprBlock,
  IrValueExpr,
  JitOperandBinding,
  JitCodegenPlan,
  ExitStore,
  PlannedExitStore,
  PlannedExit,
  ExitSnapshot,
  JitInstructionState,
  JitExitStoreUse,
  ExitPayload,
  ExitValue,
  JitProducedValue,
  JitValue,
  JitBlock
};

export function onlyExit(exits: readonly PlannedExit[], reason: ExitReason): PlannedExit {
  const matches = exits.filter((entry) => entry.reason === reason);

  strictEqual(matches.length, 1);
  return matches[0]!;
}

export function planValueCacheForTest(input: Readonly<{
  operands?: readonly JitOperandBinding[];
  expressionBlock: IrExprBlock;
  producedByVar?: ReadonlyMap<number, JitProducedValue>;
  extraUses?: ReadonlyMap<number, readonly JitValueUseRoot[]>;
}>) {
  const operands = input.operands ?? [];
  const valueTimeline = buildTimeline({
    operands,
    expressions: input.expressionBlock,
    entry: createJitValueState().snapshot(),
    ...(input.producedByVar === undefined
      ? {}
      : { producedByVar: input.producedByVar })
  });
  const plannedValueUses = planJitValueUses([{
    expressionBlock: input.expressionBlock,
    valueTimeline,
    expressionPaths: rootExpressionPaths(input.expressionBlock),
    extraUses: input.extraUses ?? new Map()
  }]);

  return planJitValueCacheForInstructions([{
    operands,
    expressionBlock: input.expressionBlock,
    valueTimeline
  }], plannedValueUses);
}

export function extraUse(
  value: JitValue,
  purpose = "exit store"
): JitValueUseRoot {
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

export function captureBeforeStores(store: ExitStore): PlannedExitStore {
  return {
    ...store,
    sourceCapture: {
      kind: "beforeStores",
      reason: "targetClobber"
    }
  };
}

export function plannedRegisterStores(exit: PlannedExit): readonly ExitStore[] {
  return exit.stores.filter((store) =>
    store.target.kind === "reg32" || store.target.kind === "reg16" || store.target.kind === "reg8"
  );
}

export function plannedFlagStores(exit: PlannedExit): readonly ExitStore[] {
  return exit.stores.filter((store) => store.target.kind === "aluFlags");
}

export function exitStoreUse(
  store: ExitStore,
  exitPoint: PlannedExit,
  exitIndex: number
): JitExitStoreUse {
  return {
    purpose: "exitStore",
    target: store.target,
    value: store.value,
    placement: {
      instructionIndex: exitPoint.at.instructionIndex,
      opIndex: exitPoint.at.opIndex,
      exitIndex,
      exitId: exitPoint.id,
      reason: exitPoint.reason,
      exitStoreIndex: exitPoint.exitStoreIndex
    },
    path: exitPoint.path
  };
}

export function exitPoint(input: Readonly<{
  instructionIndex: number;
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
  const at = {
    instructionIndex: input.instructionIndex,
    opIndex: input.opIndex
  };

  return {
    id: `${at.instructionIndex}:${at.opIndex}:${kind}`,
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

export function instructionState(input: Readonly<{
  instructionId: string;
  eip: number;
  nextEip: number;
  nextMode: "continue" | "exit";
  instructionCountDelta: number;
  changedRegs?: readonly Reg32[];
  paths?: JitInstructionState["paths"];
  exitCount: number;
}>): JitInstructionState {
  const initialState = exitState(input.instructionCountDelta, input.changedRegs ?? []);

  return {
    instructionId: input.instructionId,
    eip: input.eip,
    nextEip: input.nextEip,
    nextMode: input.nextMode,
    instructionCountDelta: input.instructionCountDelta,
    initialValueState: initialState.valueState,
    paths: input.paths ?? new Map(),
    exitCount: input.exitCount
  };
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
    instructionCountDelta,
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
