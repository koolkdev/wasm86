import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { wasmMemoryIndex } from "#backends/wasm/abi.js";
import {
  cleanValueWidth,
  dirtyValueWidth,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason } from "#backends/wasm/exit.js";
import {
  createMemoryEffectsEmitter,
  type MemoryGuardEffect
} from "#backends/wasm/jit/codegen/emit/memory-effects.js";
import type { ValueCache } from "#backends/wasm/jit/codegen/emit/cache.js";
import type { ExitFrame } from "#backends/wasm/jit/codegen/emit/exit-frame.js";
import type { ValueEmitter } from "#backends/wasm/jit/codegen/emit/values.js";
import { rootPath } from "#backends/wasm/jit/analysis/paths.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import type {
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import {
  wasmBodyInstructions,
  wasmBodyMemoryAccesses,
  wasmBodyOpcodes
} from "#backends/wasm/tests/body-opcodes.js";

test("JIT memory guard emits address once and captures fault destination before guard checks", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const events: string[] = [];
  const address = constValue(0x60);
  const memory = createMemoryEffectsEmitter({
    body,
    scratch,
    values: recordingValues(body, events, new Map([[address, "address"]])),
    exitFrame: recordingExitFrame(body, events)
  });

  memory.emit({
    kind: "memoryGuard",
    at: placement(),
    address,
    byteLength: 4,
    access: "read",
    exit: memoryExit("read")
  });
  scratch.assertClear();
  body.end();

  const encoded = body.encode();
  const instructions = wasmBodyInstructions(encoded);
  const opcodes = wasmBodyOpcodes(encoded);

  deepStrictEqual(events, [
    "value:address:32",
    "capture:memoryReadFault",
    "metadata:memoryReadFault",
    "metadata:memoryReadFault"
  ]);
  const firstGuardCheckIndex = instructions.findIndex((instruction) =>
    instruction.opcode === wasmOpcode.memorySize
  );

  strictEqual(
    instructions.slice(0, firstGuardCheckIndex).filter((instruction) =>
      instruction.opcode === wasmOpcode.localSet
    ).length,
    1
  );
  strictEqual(countOpcode(opcodes, wasmOpcode.memorySize), 2);
  strictEqual(
    instructions.findIndex((instruction) => instruction.opcode === wasmOpcode.localSet) <
      firstGuardCheckIndex,
    true
  );
});

test("JIT memory guard requires an exit reason matching read or write access", () => {
  const body = new WasmFunctionBodyEncoder();
  const memory = createMemoryEffectsEmitter({
    body,
    scratch: new WasmLocalScratchAllocator(body),
    values: recordingValues(body, [], new Map()),
    exitFrame: recordingExitFrame(body, [])
  });

  throws(
    () => memory.emit({
      kind: "memoryGuard",
      at: placement(),
      address: constValue(0x60),
      byteLength: 4,
      access: "write",
      exit: memoryExit("read")
    }),
    /JIT memory write guard received exit reason/
  );
});

test("JIT memory store emits address before value and cleans dirty 32-bit stores", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const events: string[] = [];
  const address = constValue(0x80);
  const value = constValue(0x1234);
  const labels = new Map<JitValue, string>([
    [address, "address"],
    [value, "value"]
  ]);
  const widths = new Map<JitValue, ValueWidth>([
    [value, dirtyValueWidth(8)]
  ]);
  const memory = createMemoryEffectsEmitter({
    body,
    scratch,
    values: recordingValues(body, events, labels, widths),
    exitFrame: recordingExitFrame(body, events)
  });

  memory.emit({
    kind: "memoryStore",
    at: placement(),
    address,
    value,
    width: 32
  });
  scratch.assertClear();
  body.end();

  const encoded = body.encode();
  const opcodes = wasmBodyOpcodes(encoded);

  deepStrictEqual(events, [
    "value:address:32",
    "value:value:none"
  ]);
  strictEqual(opcodes.indexOf(wasmOpcode.i32Const) < opcodes.lastIndexOf(wasmOpcode.i32Const), true);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 1);
  deepStrictEqual(wasmBodyMemoryAccesses(encoded), [{
    opcode: wasmOpcode.i32Store,
    memoryIndex: wasmMemoryIndex.guest,
    offset: 0
  }]);
});

test("JIT produced memory load is defined through the produced-value path", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const events: string[] = [];
  const address = constValue(0x90);
  let definedWidth: ValueWidth | undefined;
  const memory = createMemoryEffectsEmitter({
    body,
    scratch,
    exitFrame: recordingExitFrame(body, events),
    values: recordingValues(body, events, new Map([[address, "address"]])),
    valueCache: capturingValueCache(events, (emit) => {
      definedWidth = emit();
      return definedWidth;
    })
  });

  memory.emit({
    kind: "memoryLoad",
    at: placement(),
    result: producedValue("load#memory-effects"),
    address,
    width: 8,
    signed: true
  });
  scratch.assertClear();
  body.end();

  deepStrictEqual(events, [
    "capture:load#memory-effects",
    "value:address:32"
  ]);
  strictEqual(definedWidth?.cleanWidth, 32);
  deepStrictEqual(wasmBodyMemoryAccesses(body.encode()), [{
    opcode: wasmOpcode.i32Load8S,
    memoryIndex: wasmMemoryIndex.guest,
    offset: 0
  }]);
});

test("JIT produced memory load does not emit when the produced path declines it", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const events: string[] = [];
  const memory = createMemoryEffectsEmitter({
    body,
    scratch,
    values: recordingValues(body, events, new Map()),
    exitFrame: recordingExitFrame(body, events),
    valueCache: decliningValueCache(events)
  });

  memory.emit({
    kind: "memoryLoad",
    at: placement(),
    result: producedValue("load#unused"),
    address: constValue(0xa0),
    width: 32,
    signed: false
  });
  scratch.assertClear();
  body.end();

  deepStrictEqual(events, ["capture:load#unused"]);
  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Load), 0);
});

function recordingValues(
  body: WasmFunctionBodyEncoder,
  events: string[],
  labels: ReadonlyMap<JitValue, string>,
  widths: ReadonlyMap<JitValue, ValueWidth> = new Map()
): ValueEmitter {
  const emit = (value: JitValue, options?: Parameters<ValueEmitter["emit"]>[1]) => {
    events.push(`value:${labels.get(value) ?? value.kind}:${options?.requestedWidth ?? "none"}`);
    body.i32Const(value.kind === "const" ? value.value : 0);
    return widths.get(value) ?? cleanValueWidth(32);
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
    emitMetadata: (exit) => {
      events.push(`metadata:${exit.kind}`);
    },
    emitLinkedStores: () => {
      throw new Error("unexpected linked exit stores");
    }
  };
}

function capturingValueCache(
  events: string[],
  capture: (emit: () => ValueWidth) => ValueWidth
): ValueCache {
  return {
    beginInstruction: () => {},
    beginOp: () => {},
    enterPath: () => {},
    leavePath: () => {},
    emitForUse: () => {
      throw new Error("unexpected value cache use");
    },
    capture: (value, emit) => {
      events.push(`capture:${value.kind === "produced" ? value.id : value.kind}`);
      const valueWidth = capture(emit);

      return {
        local: 0,
        valueWidth,
        emitted: true,
        retain: () => {
          throw new Error("unexpected retain");
        },
        release: () => {}
      };
    },
    canInline: () => true
  };
}

function decliningValueCache(events: string[]): ValueCache {
  return {
    ...capturingValueCache(events, () => {
      throw new Error("unexpected value cache capture emission");
    }),
    capture: (value) => {
      events.push(`capture:${value.kind === "produced" ? value.id : value.kind}`);
      return undefined;
    }
  };
}

function placement(): MemoryGuardEffect["at"] {
  return {
    instructionIndex: 0,
    opIndex: 0,
    epoch: 0
  };
}

function memoryExit(access: "read" | "write"): Exit {
  const read = access === "read";

  return {
    id: read ? "memoryReadFault" : "memoryWriteFault",
    at: {
      instructionIndex: 0,
      opIndex: 0
    },
    kind: read ? "memoryReadFault" : "memoryWriteFault",
    reason: read ? ExitReason.MEMORY_READ_FAULT : ExitReason.MEMORY_WRITE_FAULT,
    snapshot: {
      instructionCountDelta: 0,
      valueState: createJitValueState().snapshot()
    },
    visibleEip: {
      kind: "static",
      value: 0x1000
    },
    payload: {
      kind: "runtime",
      source: "memoryAddress"
    },
    path: rootPath()
  };
}

function constValue(value: number): JitValue {
  return {
    kind: "const",
    type: "i32",
    value
  };
}

function producedValue(id: string): JitProducedValue {
  return {
    kind: "produced",
    id,
    type: "i32"
  };
}

function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodes.filter((entry) => entry === opcode).length;
}
