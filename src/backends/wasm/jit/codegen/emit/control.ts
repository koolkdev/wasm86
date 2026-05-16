import { i32, u32 } from "#x86/state/cpu-state.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { emitWasmIrExitFromI32Stack } from "#backends/wasm/codegen/exit.js";
import type { PlannedExit } from "#backends/wasm/jit/codegen/plan/types.js";
import type { Path } from "#backends/wasm/jit/analysis/paths.js";
import type { Effect } from "#backends/wasm/jit/codegen/plan/effect-types.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { JitInstructionEmitContext } from "./block-emitter.js";
import { emitJitValue } from "./jit-values.js";

export function emitJitNext(
  context: JitInstructionEmitContext,
  effect: Extract<Effect, { kind: "fallthrough" }>
): void {
  const instruction = context.currentInstruction();

  if (instruction.nextMode === "exit") {
    emitJitStaticControlTransfer(context, instruction.nextEip, effect.exit);
    return;
  }

  context.advanceInstruction();
}

export function emitJitJump(
  context: JitInstructionEmitContext,
  effect: Extract<Effect, { kind: "jump" }>
): void {
  if (emitJitControlTransfer(context, effect.target, effect.exit)) {
    return;
  }
}

export function emitJitControlExit(
  context: JitInstructionEmitContext,
  target: JitValue,
  exit: PlannedExit,
  extraDepth = 0
): void {
  const targetLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    emitJitValue(context.jitValueEmitContext(), target, { requestedWidth: 32 });
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
  effect: Extract<Effect, { kind: "branch" }>
): void {
  emitJitValue(context.jitValueEmitContext(), effect.condition, { requestedWidth: 32 });
  context.body.ifBlock();
  emitJitControlTransfer(context, effect.takenTarget, effect.taken, 1);
  context.body.elseBlock();
  emitJitControlTransfer(context, effect.notTakenTarget, effect.notTaken, 1);
  context.body.endBlock();
}

export function emitJitHostTrap(
  context: JitInstructionEmitContext,
  effect: Extract<Effect, { kind: "hostTrap" }>
): void {
  const vectorLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    emitWithValuePath(context, effect.exit.path, () => {
      emitJitValue(context.jitValueEmitContext(), effect.vector, { requestedWidth: 32 });
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
  target: JitValue,
  exit: PlannedExit,
  extraDepth = 0
): boolean {
  return emitWithValuePath(context, exit.path, () => {
    const targetEip = staticControlTarget(exit, target);

    if (targetEip === undefined) {
      emitJitControlExit(context, target, exit, extraDepth);
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
  context.state.emitExitStores(exit.exitStoreIndex);
}

function staticControlTarget(exit: PlannedExit, target: JitValue): number | undefined {
  void target;

  if (exit.payload.kind === "static") {
    return u32(exit.payload.value);
  }

  return undefined;
}
