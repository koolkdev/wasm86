import { u32 } from "#x86/state/cpu-state.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import {
  emitWasmIrExitConstPayload,
  emitWasmIrExitFromI32Stack
} from "#backends/wasm/codegen/exit.js";
import type { JitModuleLinkTable } from "#backends/wasm/jit/compiled-blocks/module-link-table.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import type { Path } from "#backends/wasm/jit/analysis/paths.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { ValueCache } from "./cache.js";
import type { ValueEmitter } from "./values.js";
import type { ExitFrame } from "./exit-frame.js";

export type JitLinkResolver = Readonly<{
  moduleTable?: JitModuleLinkTable;
  functionIndexForStaticTarget?: (eip: number) => number | undefined;
  slotForStaticTarget?: (eip: number) => number;
}>;

export type JitLinkEmitContext = JitLinkResolver & Readonly<{
  blockTypeIndex: number;
  tableIndex?: number;
}>;

export type BranchControlExit = Readonly<{
  target: JitValue;
  exit: Exit;
}>;

export type ControlExitEmitter = Readonly<{
  emitJump(target: JitValue, exit: Exit): void;
  emitBranch(condition: JitValue, taken: BranchControlExit, notTaken: BranchControlExit): void;
  emitHostTrap(vector: JitValue, exit: Exit): void;
  emitFallthrough(exit: Exit): void;
}>;

export type ControlExitEmitterContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueEmitter;
  frame: ExitFrame;
  valueCache?: ValueCache | undefined;
  linking?: JitLinkEmitContext | undefined;
}>;

export function createControlExitEmitter(
  context: ControlExitEmitterContext
): ControlExitEmitter {
  const {
    body,
    scratch,
    values,
    frame,
    valueCache,
    linking
  } = context;

  return {
    emitJump: (target, exit) => {
      emitControlTransfer(target, exit);
    },
    emitBranch: (condition, taken, notTaken) => {
      values.emit(condition, { requestedWidth: 32 });
      body.ifBlock();
      emitControlTransfer(taken.target, taken.exit, 1);
      body.elseBlock();
      emitControlTransfer(notTaken.target, notTaken.exit, 1);
      body.endBlock();
    },
    emitHostTrap: (vector, exit) => {
      withValuePath(exit.path, () => {
        assertRuntimePayload(exit, "hostTrapVector");

        const vectorLocal = scratch.allocLocal(wasmValueType.i32);

        try {
          values.emit(vector, { requestedWidth: 32 });
          body.localSet(vectorLocal);
          const destination = frame.captureDestination(exit);

          body.localGet(vectorLocal);
          frame.emitMetadata(exit);
          emitWasmIrExitFromI32Stack(body, {
            destination,
            reason: exit.reason
          });
        } finally {
          scratch.freeLocal(vectorLocal);
        }
      });
    },
    emitFallthrough: (exit) => {
      withValuePath(exit.path, () => {
        if (exit.payload.kind !== "static") {
          throw new Error(`JIT ${exit.kind} exit requires a static payload`);
        }

        const targetEip = u32(exit.payload.value);

        if (emitLinkedStaticControlTransfer(targetEip, exit)) {
          return;
        }

        const destination = frame.captureDestination(exit);

        frame.emitMetadata(exit);
        emitWasmIrExitConstPayload(body, {
          destination,
          reason: exit.reason,
          payload: targetEip
        });
      });
    }
  };

  function emitControlTransfer(
    target: JitValue,
    exit: Exit,
    extraDepth = 0
  ): void {
    withValuePath(exit.path, () => {
      switch (exit.payload.kind) {
        case "runtime":
          emitDynamicControlTransfer(target, exit, extraDepth);
          return;
        case "static":
          emitStaticControlTransfer(u32(exit.payload.value), exit, extraDepth);
          return;
      }
    });
  }

  function emitDynamicControlTransfer(
    target: JitValue,
    exit: Exit,
    extraDepth: number
  ): void {
    assertRuntimePayload(exit, "controlTarget");

    const targetLocal = scratch.allocLocal(wasmValueType.i32);

    try {
      values.emit(target, { requestedWidth: 32 });
      body.localSet(targetLocal);
      const destination = frame.captureDestination(exit);

      body.localGet(targetLocal);
      frame.emitMetadata(exit, {
        emitRuntimeVisibleEip: () => {
          body.localGet(targetLocal);
        }
      });
      emitWasmIrExitFromI32Stack(body, {
        destination,
        reason: exit.reason,
        extraDepth
      });
    } finally {
      scratch.freeLocal(targetLocal);
    }
  }

  function emitStaticControlTransfer(
    targetEip: number,
    exit: Exit,
    extraDepth: number
  ): void {
    if (emitLinkedStaticControlTransfer(targetEip, exit)) {
      return;
    }

    const destination = frame.captureDestination(exit);

    frame.emitMetadata(exit);
    emitWasmIrExitConstPayload(body, {
      destination,
      reason: exit.reason,
      payload: targetEip,
      extraDepth
    });
  }

  function emitLinkedStaticControlTransfer(
    targetEip: number,
    exit: Exit
  ): boolean {
    if (linking === undefined) {
      return false;
    }

    const directFunctionIndex = linking.functionIndexForStaticTarget?.(targetEip);

    if (directFunctionIndex !== undefined) {
      frame.emitLinkedStores(exit);
      body.returnCallFunction(directFunctionIndex);
      return true;
    }

    if (linking.tableIndex !== undefined && linking.slotForStaticTarget !== undefined) {
      frame.emitLinkedStores(exit);
      body
        .i32Const(linking.slotForStaticTarget(targetEip))
        .returnCallIndirect(linking.blockTypeIndex, linking.tableIndex);
      return true;
    }

    return false;
  }

  function withValuePath<T>(
    path: Path,
    emit: () => T
  ): T {
    valueCache?.enterPath(path);

    try {
      return emit();
    } finally {
      valueCache?.leavePath();
    }
  }
}

function assertRuntimePayload(
  exit: Exit,
  source: Exclude<Exit["payload"], { kind: "static" }>["source"]
): void {
  if (exit.payload.kind !== "runtime" || exit.payload.source !== source) {
    throw new Error(`JIT ${exit.kind} exit requires runtime ${source} payload`);
  }
}
