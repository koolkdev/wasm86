import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { i32, u32 } from "#x86/state/cpu-state.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { emitWasmIrExitFromI32Stack } from "#backends/wasm/codegen/exit.js";
import type { WasmIrEmitHelpers } from "#backends/wasm/codegen/emit.js";
import type { PlannedExit } from "#backends/wasm/jit/codegen/plan/types.js";
import type { Path } from "#backends/wasm/jit/analysis/paths.js";
import type { JitPlannedEffect } from "#backends/wasm/jit/codegen/plan/effect-plan.js";
import type { JitInstructionEmitContext } from "./block-emitter.js";

export function emitJitNext(
  context: JitInstructionEmitContext,
  effect: Extract<JitPlannedEffect, { kind: "fallthrough" }>
): void {
  const instruction = context.currentInstruction();

  if (instruction.nextMode === "exit") {
    emitJitStaticControlTransfer(context, instruction.nextEip, effect.exit);
    return;
  }

  context.advanceInstruction();
}

export function emitJitNextEip(context: JitInstructionEmitContext): void {
  context.body.i32Const(i32(context.currentInstruction().nextEip));
}

export function emitJitJump(
  context: JitInstructionEmitContext,
  target: IrValueExpr,
  effect: Extract<JitPlannedEffect, { kind: "jump" }>,
  helpers: WasmIrEmitHelpers
): void {
  if (emitJitControlTransfer(context, target, effect.exit, helpers)) {
    return;
  }
}

export function emitJitControlExit(
  context: JitInstructionEmitContext,
  target: IrValueExpr,
  exit: PlannedExit,
  helpers: WasmIrEmitHelpers,
  extraDepth = 0
): void {
  const targetLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    helpers.emitValue(target, { requestedWidth: 32 });
    context.body.localSet(targetLocal);

    context.state.commitInstructionExit(exit, () => {
      context.body.localGet(targetLocal);
    });
    context.body.localGet(targetLocal);
    emitWasmIrExitFromI32Stack(context.body, context.exit, exit.reason, extraDepth);
  } finally {
    context.scratch.freeLocal(targetLocal);
  }
}

export function emitJitConditionalJump(
  context: JitInstructionEmitContext,
  condition: IrValueExpr,
  taken: IrValueExpr,
  notTaken: IrValueExpr,
  effect: Extract<JitPlannedEffect, { kind: "branch" }>,
  helpers: WasmIrEmitHelpers
): void {
  helpers.emitValue(condition, { requestedWidth: 32 });
  context.body.ifBlock();
  emitJitControlTransfer(context, taken, effect.taken, helpers, 1);
  context.body.elseBlock();
  emitJitControlTransfer(context, notTaken, effect.notTaken, helpers, 1);
  context.body.endBlock();
}

export function emitJitHostTrap(
  context: JitInstructionEmitContext,
  vector: IrValueExpr,
  effect: Extract<JitPlannedEffect, { kind: "hostTrap" }>,
  helpers: WasmIrEmitHelpers
): void {
  const vectorLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    emitWithValuePath(context, effect.exit.path, () => {
      helpers.emitValue(vector, { requestedWidth: 32 });
      context.body.localSet(vectorLocal);
      context.state.commitInstructionExit(effect.exit);
      context.body.localGet(vectorLocal);
      emitWasmIrExitFromI32Stack(context.body, context.exit, effect.exit.reason);
    });
  } finally {
    context.scratch.freeLocal(vectorLocal);
  }
}

function emitJitControlTransfer(
  context: JitInstructionEmitContext,
  target: IrValueExpr,
  exit: PlannedExit,
  helpers: WasmIrEmitHelpers,
  extraDepth = 0
): boolean {
  return emitWithValuePath(context, exit.path, () => {
    const targetEip = staticControlTarget(context, target);

    if (targetEip === undefined) {
      emitJitControlExit(context, target, exit, helpers, extraDepth);
      return false;
    }

    emitJitStaticControlTransfer(context, targetEip, exit, extraDepth);
    return true;
  });
}

function emitWithValuePath<T>(
  context: JitInstructionEmitContext,
  path: Path,
  emit: () => T
): T {
  context.valueCache?.enterPath(path);

  try {
    return emit();
  } finally {
    context.valueCache?.leavePath();
  }
}

function emitJitStaticControlTransfer(
  context: JitInstructionEmitContext,
  targetEip: number,
  exit: PlannedExit,
  extraDepth = 0
): void {
  context.state.commitInstructionExit(exit);

  if (emitJitLinkedStaticControlTransfer(context, targetEip, exit)) {
    return;
  }

  context.body.i32Const(i32(targetEip));
  emitWasmIrExitFromI32Stack(context.body, context.exit, exit.reason, extraDepth);
}

function emitJitLinkedStaticControlTransfer(
  context: JitInstructionEmitContext,
  targetEip: number,
  exit: PlannedExit
): boolean {
  const linking = context.linking;

  if (linking === undefined) {
    return false;
  }

  const directFunctionIndex = linking.functionIndexForStaticTarget?.(targetEip);

  if (directFunctionIndex !== undefined) {
    emitJitLinkedControlTransferStateStores(context, exit);
    context.body.returnCallFunction(directFunctionIndex);
    return true;
  }

  if (linking.tableIndex !== undefined && linking.slotForStaticTarget !== undefined) {
    emitJitLinkedControlTransferStateStores(context, exit);
    context.body
      .i32Const(linking.slotForStaticTarget(targetEip))
      .returnCallIndirect(linking.blockTypeIndex, linking.tableIndex);
    return true;
  }

  return false;
}

function emitJitLinkedControlTransferStateStores(
  context: JitInstructionEmitContext,
  exit: PlannedExit
): void {
  context.exit.emitBeforeExit?.();
  context.state.emitExitMaterializationStores(exit.exitMaterializationIndex);
}

function staticControlTarget(context: JitInstructionEmitContext, target: IrValueExpr): number | undefined {
  const instruction = context.currentInstruction();

  if (instruction.nextMode !== "exit") {
    return undefined;
  }

  switch (target.kind) {
    case "const":
      return u32(target.value);
    case "nextEip":
      return u32(instruction.nextEip);
    case "source": {
      if (target.source.kind !== "operand") {
        return undefined;
      }

      const binding = instruction.operands[target.source.index];

      return binding?.kind === "static.relTarget" ? binding.target : undefined;
    }
    default:
      return undefined;
  }
}
