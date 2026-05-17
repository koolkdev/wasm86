import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { cleanValueWidth, type ValueWidth } from "#backends/wasm/codegen/value-width.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason } from "#backends/wasm/exit.js";
import {
  createControlEffectsEmitter
} from "#backends/wasm/jit/codegen/emit/control-effects.js";
import type { ExitFrame } from "#backends/wasm/jit/codegen/emit/exit-frame.js";
import type { ExitMetadataSelection } from "#backends/wasm/jit/codegen/emit/exit-metadata.js";
import type { ValueEmitter } from "#backends/wasm/jit/codegen/emit/values.js";
import type { ValueCache } from "#backends/wasm/jit/codegen/emit/cache.js";
import {
  branchPath,
  rootPath,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  wasmBodyInstructions,
  wasmBodyOpcodes
} from "#backends/wasm/tests/body-opcodes.js";

test("JIT control effects emit branch arms under their exit paths", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const events: string[] = [];
  const condition = constValue(1);
  const takenTarget = constValue(0x2000);
  const notTakenTarget = constValue(0x3000);
  const control = createControlEffectsEmitter({
    body,
    scratch,
    values: recordingValues(body, events, new Map([
      [condition, "condition"],
      [takenTarget, "takenTarget"],
      [notTakenTarget, "notTakenTarget"]
    ])),
    frame: recordingExitFrame(body, events),
    valueCache: recordingValueCache(events)
  });

  control.emit({
    kind: "branch",
    at: placement(),
    condition,
    takenTarget,
    notTakenTarget,
    taken: controlExit("branchTaken", branchPath(0, 0, "taken")),
    notTaken: controlExit("branchNotTaken", branchPath(0, 0, "notTaken"))
  });
  scratch.assertClear();
  body.end();

  deepStrictEqual(events, [
    "value:condition:32",
    "enter:branch:0:0:taken",
    "value:takenTarget:32",
    "capture:branchTaken",
    "metadata:branchTaken",
    "runtime-visible",
    "leave",
    "enter:branch:0:0:notTaken",
    "value:notTakenTarget:32",
    "capture:branchNotTaken",
    "metadata:branchNotTaken",
    "runtime-visible",
    "leave"
  ]);
  strictEqual(wasmBodyOpcodes(body.encode()).includes(wasmOpcode.if), true);
});

test("JIT control effects emit host traps through value and exit frame paths", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const events: string[] = [];
  const vector = constValue(0x2e);
  const control = createControlEffectsEmitter({
    body,
    scratch,
    values: recordingValues(body, events, new Map([[vector, "vector"]])),
    frame: recordingExitFrame(body, events),
    valueCache: recordingValueCache(events)
  });

  control.emit({
    kind: "hostTrap",
    at: placement(),
    vector,
    exit: hostTrapExit()
  });
  scratch.assertClear();
  body.end();

  const instructions = wasmBodyInstructions(body.encode());
  const vectorStoreIndex = instructions.findIndex((instruction) =>
    instruction.opcode === wasmOpcode.localSet
  );
  const metadataIndex = events.indexOf("metadata:hostTrap");

  deepStrictEqual(events, [
    "enter:root",
    "value:vector:32",
    "capture:hostTrap",
    "metadata:hostTrap",
    "leave"
  ]);
  strictEqual(vectorStoreIndex !== -1, true);
  strictEqual(metadataIndex > events.indexOf("capture:hostTrap"), true);
});

function recordingValues(
  body: WasmFunctionBodyEncoder,
  events: string[],
  labels: ReadonlyMap<JitValue, string>
): ValueEmitter {
  const emit = (value: JitValue, options?: Parameters<ValueEmitter["emit"]>[1]): ValueWidth => {
    events.push(`value:${labels.get(value) ?? value.kind}:${options?.requestedWidth ?? "none"}`);
    body.i32Const(value.kind === "const" ? value.value : 0);
    return cleanValueWidth(32);
  };

  return {
    emit,
    emitInline: emit,
    emitMasked: (value) => emit(value)
  };
}

function recordingExitFrame(
  body: WasmFunctionBodyEncoder,
  events: string[]
): ExitFrame {
  const exitLocal = body.addLocal(wasmValueType.i64);

  return {
    openDeferredBlocks: () => {},
    emitDeferredReturns: () => {},
    captureDestination: (exit) => {
      events.push(`capture:${exit.kind}`);
      return {
        exitLocal,
        labelDepth: 0
      };
    },
    emitMetadata: (exit, selection?: ExitMetadataSelection) => {
      events.push(`metadata:${exit.kind}`);
      selection?.emitRuntimeVisibleEip?.();

      if (selection?.emitRuntimeVisibleEip !== undefined) {
        events.push("runtime-visible");
      }
    },
    emitLinkedStores: () => {
      throw new Error("unexpected linked stores");
    }
  };
}

function recordingValueCache(events: string[]): ValueCache {
  return {
    beginInstruction: () => {},
    beginOp: () => {},
    enterPath: (path) => {
      events.push(`enter:${path.id}`);
    },
    leavePath: () => {
      events.push("leave");
    },
    emitForUse: () => {
      throw new Error("unexpected cache use");
    },
    capture: () => {
      throw new Error("unexpected cache capture");
    },
    canInline: () => true
  };
}

function controlExit(kind: "branchTaken" | "branchNotTaken", path: Path): Exit {
  return {
    id: kind,
    at: {
      instructionIndex: 0,
      opIndex: 0
    },
    kind,
    reason: ExitReason.JUMP,
    snapshot: {
      instructionCountDelta: 0,
      valueState: createJitValueState().snapshot()
    },
    visibleEip: {
      kind: "runtime",
      source: "controlTarget"
    },
    payload: {
      kind: "runtime",
      source: "controlTarget"
    },
    path
  };
}

function hostTrapExit(): Exit {
  return {
    id: "hostTrap",
    at: {
      instructionIndex: 0,
      opIndex: 0
    },
    kind: "hostTrap",
    reason: ExitReason.HOST_TRAP,
    snapshot: {
      instructionCountDelta: 0,
      valueState: createJitValueState().snapshot()
    },
    visibleEip: {
      kind: "static",
      value: 0x1001
    },
    payload: {
      kind: "runtime",
      source: "hostTrapVector"
    },
    path: rootPath()
  };
}

function placement() {
  return {
    instructionIndex: 0,
    opIndex: 0,
    epoch: 0
  };
}

function constValue(value: number): JitValue {
  return {
    kind: "const",
    type: "i32",
    value
  };
}
