import { assert } from "#common/assert.js";
import type { BlockExit } from "#ir/block/exits.js";
import {
  ExitReason,
  type ExitReason as ExitReasonValue
} from "#wasm/exit.js";
import type {
  WasmExitTarget,
  WasmExitTargetInput
} from "./exit-targets.js";
import type {
  WasmExitEmitter,
  WasmExitEmitInput
} from "./types.js";

export type WasmExitRegionPayload =
  | Readonly<{ kind: "constant"; value: number }>
  | Readonly<{ kind: "stack" }>;

export type WasmExitRegion = Readonly<{
  payload: WasmExitRegionPayload;
  controlDepth: number;
}>;

export type WasmExitRegionContext = Readonly<{
  withControlDepth(addedDepth: number, emitRegion: () => void): void;
  withExitRegion(
    exit: BlockExit,
    payload: WasmExitRegionPayload,
    emitExitRegion: () => void
  ): void;
  currentExitRegion(exit: BlockExit): WasmExitRegion;
}>;

export type WasmExitEmitterInput = Readonly<{
  exitRegions: WasmExitRegionContext;
  target: WasmExitTarget;
}>;

export function createWasmExitRegionContext(): WasmExitRegionContext {
  const active = new Map<BlockExit["id"], WasmExitRegion>();
  let controlDepth = 0;

  return {
    withControlDepth: (addedDepth, emitRegion) => {
      const outerDepth = controlDepth;

      controlDepth = outerDepth + addedDepth;
      try {
        emitRegion();
      } finally {
        controlDepth = outerDepth;
      }
    },
    withExitRegion: (exit, payload, emitExitRegion) => {
      assert(!active.has(exit.id), `Wasm exit region is already active for exit ${exit.id}`);
      active.set(exit.id, Object.freeze({ payload, controlDepth }));
      try {
        emitExitRegion();
      } finally {
        active.delete(exit.id);
      }
    },
    currentExitRegion: (exit) => {
      const region = active.get(exit.id);

      assert(region !== undefined, `Wasm exit ${exit.id} was emitted outside its edge region`);
      return region;
    }
  };
}

export function createWasmExitEmitter(input: WasmExitEmitterInput): WasmExitEmitter {
  return {
    emitExit: (exit) => emitExit(input.exitRegions, input.target, exit)
  };
}

function emitExit(
  exitRegions: WasmExitRegionContext,
  target: WasmExitTarget,
  input: WasmExitEmitInput
): void {
  const encoded = exitEncoding(input.exit);
  const region = exitRegions.currentExitRegion(input.exit);

  switch (region.payload.kind) {
    case "constant":
      assert(
        input.exit.kind === "branchNotTaken" || input.exit.kind === "fallthrough",
        `Wasm ${input.exit.kind} exit ${input.exit.id} requires a stack payload`
      );
      target.emitConstantPayload({
        ...exitTargetInput(input.exit, encoded, region),
        payload: region.payload.value
      });
      return;
    case "stack":
      target.emitStackPayload(exitTargetInput(input.exit, encoded, region));
      return;
  }
}

function exitTargetInput(
  exit: BlockExit,
  encoded: ReturnType<typeof exitEncoding>,
  region: WasmExitRegion
): WasmExitTargetInput {
  return {
    exit,
    reason: encoded.reason,
    controlDepth: region.controlDepth,
    ...(encoded.detail === undefined ? {} : { detail: encoded.detail })
  };
}

function exitEncoding(exit: BlockExit): Readonly<{
  reason: ExitReasonValue;
  detail?: number;
}> {
  switch (exit.kind) {
    case "memoryFault":
      assert(exit.payload.kind === "memoryFault", "memoryFault exit has non-memory-fault payload");
      return {
        reason: exit.payload.access === "read"
          ? ExitReason.MEMORY_READ_FAULT
          : ExitReason.MEMORY_WRITE_FAULT,
        detail: exit.payload.byteLength
      };
    case "jump":
      assert(exit.payload.kind === "jump", "jump exit has non-jump payload");
      return { reason: ExitReason.JUMP };
    case "branchTaken":
      assert(
        exit.payload.kind === "branch" && exit.payload.direction === "taken",
        "branchTaken exit has non-taken payload"
      );
      return { reason: ExitReason.JUMP };
    case "branchNotTaken":
      assert(
        exit.payload.kind === "branch" && exit.payload.direction === "notTaken",
        "branchNotTaken exit has non-not-taken payload"
      );
      return { reason: ExitReason.JUMP };
    case "hostTrap":
      assert(exit.payload.kind === "hostTrap", "hostTrap exit has non-host-trap payload");
      return { reason: ExitReason.HOST_TRAP };
    case "fallthrough":
      assert(exit.payload.kind === "fallthrough", "fallthrough exit has non-fallthrough payload");
      return { reason: ExitReason.FALLTHROUGH };
  }
}
