import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { WasmIrExitDestination } from "#backends/wasm/codegen/exit.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import type {
  PlannedExitStore,
  PlannedExitStores,
  StoreStrategyPlan
} from "#backends/wasm/jit/codegen/plan/types.js";
import type { ValueEmitter } from "./values.js";
import type {
  ExitMetadataEmitter,
  ExitMetadataSelection
} from "./exit-metadata.js";
import type {
  CapturedExitStores,
  ExitStoreEmitter
} from "./exit-stores.js";

export type ExitStoreLayout = Readonly<{
  maxStoreIndex: number;
  storesForExit(exit: Exit): PlannedExitStores;
  storesAt(index: number): readonly PlannedExitStore[];
}>;

export type ExitFrame = Readonly<{
  openDeferredBlocks(): void;
  emitDeferredReturns(): void;
  captureDestination(values: ValueEmitter, exit: Exit): WasmIrExitDestination;
  emitMetadata(exit: Exit, selection?: ExitMetadataSelection): void;
  emitLinkedStores(values: ValueEmitter, exit: Exit): void;
}>;

export type ExitFrameInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  metadata: ExitMetadataEmitter;
  stores: ExitStoreEmitter;
  layout: ExitStoreLayout;
  exitLocal: number;
}>;

export function createExitStoreLayout(
  storeStrategy: StoreStrategyPlan
): ExitStoreLayout {
  const exitsById = new Map<string, PlannedExitStores>();

  for (const exitStores of storeStrategy.exits) {
    if (exitsById.has(exitStores.exit.id)) {
      throw new Error(`duplicate planned JIT exit: ${exitStores.exit.id}`);
    }

    exitsById.set(exitStores.exit.id, exitStores);
  }

  return {
    maxStoreIndex: storeStrategy.maxExitStoreIndex,
    storesForExit: (exit) => {
      const planned = exitsById.get(exit.id);

      if (planned === undefined) {
        throw new Error(`missing planned JIT exit stores for exit ${exit.id}`);
      }

      return planned;
    },
    storesAt: (index) => {
      const stores = storeStrategy.exitStoreSets[index]?.stores;

      if (stores === undefined) {
        throw new Error(`missing planned JIT exit store set: ${index}`);
      }

      return stores;
    }
  };
}

export function createExitFrame(input: ExitFrameInput): ExitFrame {
  const {
    body,
    metadata,
    stores,
    layout,
    exitLocal
  } = input;
  const capturedByStoreIndex = new Map<number, CapturedExitStores>();
  const deferredStoreIndexes = new Set<number>();

  return {
    openDeferredBlocks: () => {
      for (let index = 0; index <= layout.maxStoreIndex; index += 1) {
        void index;
        body.block();
      }
    },
    emitDeferredReturns: () => {
      for (let index = layout.maxStoreIndex; index >= 0; index -= 1) {
        body.endBlock();
        emitCapturedStores(index);
        body.localGet(exitLocal).returnFromFunction();
      }
    },
    captureDestination: (values, exit) => {
      const planned = layout.storesForExit(exit);

      deferredStoreIndexes.add(planned.exit.exitStoreIndex);
      captureStoreSet(values, planned);
      return {
        exitLocal,
        labelDepth: layout.maxStoreIndex - planned.exit.exitStoreIndex
      };
    },
    emitMetadata: (exit, selection) => {
      metadata.emit(exit, selection);
    },
    emitLinkedStores: (values, exit) => {
      const planned = layout.storesForExit(exit);
      const capturedStores = stores.captureSources(values, planned.stores);

      try {
        metadata.emit(exit);
        stores.emitStores(capturedStores);
      } finally {
        stores.release(capturedStores);
      }
    }
  };

  function captureStoreSet(
    values: ValueEmitter,
    planned: PlannedExitStores
  ): CapturedExitStores {
    const index = planned.exit.exitStoreIndex;
    const captured = capturedByStoreIndex.get(index);

    if (captured !== undefined) {
      return captured;
    }

    const next = stores.captureSources(values, planned.stores);

    capturedByStoreIndex.set(index, next);
    return next;
  }

  function emitCapturedStores(index: number): void {
    const plannedStores = layout.storesAt(index);
    const capturedStores = capturedByStoreIndex.get(index);

    if (
      deferredStoreIndexes.has(index) &&
      plannedStores.length !== 0 &&
      capturedStores === undefined
    ) {
      throw new Error(`JIT exit store set was not captured: ${index}`);
    }

    if (capturedStores !== undefined) {
      stores.emitStores(capturedStores);
      stores.release(capturedStores);
    }
    capturedByStoreIndex.delete(index);
  }
}
