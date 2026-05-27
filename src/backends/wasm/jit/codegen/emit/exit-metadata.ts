import { i32 } from "#x86/numeric.js";
import { stateOffset } from "#wasm/abi.js";
import { emitLoadStateU32, emitStoreStateU32 } from "#wasm/codegen/state.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";

export type ExitMetadataEmitter = Readonly<{
  beginBlock(): void;
  emit(exit: Exit, selection?: ExitMetadataSelection): void;
}>;

export type ExitMetadataSelection = Readonly<{
  emitRuntimeVisibleEip?: () => void;
}>;

export function createExitMetadataEmitter(
  body: WasmFunctionBodyEncoder
): ExitMetadataEmitter {
  const instructionCountLocal = body.addLocal(wasmValueType.i32);

  return {
    beginBlock: () => {
      emitLoadStateU32(body, stateOffset.instructionCount);
      body.localSet(instructionCountLocal);
    },
    emit: (exit, selection) => {
      assertRuntimeVisibleEipEmitter(exit, selection);

      emitStoreStateU32(body, stateOffset.eip, () => {
        emitExitVisibleEip(exit, selection);
      });
      emitStoreStateU32(body, stateOffset.instructionCount, () => {
        body.localGet(instructionCountLocal);

        if (exit.snapshot.progress.instructionCountDelta !== 0) {
          body.i32Const(exit.snapshot.progress.instructionCountDelta).i32Add();
        }
      });
    }
  };

  function assertRuntimeVisibleEipEmitter(
    exit: Exit,
    selection: ExitMetadataSelection | undefined
  ): void {
    if (exit.visibleEip.kind === "runtime" && selection?.emitRuntimeVisibleEip === undefined) {
      throw new Error("JIT runtime visible EIP requested without an emitter");
    }
  }

  function emitExitVisibleEip(
    exit: Exit,
    selection: ExitMetadataSelection | undefined
  ): void {
    switch (exit.visibleEip.kind) {
      case "static":
        body.i32Const(i32(exit.visibleEip.value));
        return;
      case "runtime":
        if (selection?.emitRuntimeVisibleEip === undefined) {
          throw new Error("JIT runtime visible EIP requested without an emitter");
        }

        selection.emitRuntimeVisibleEip();
        return;
    }
  }
}
