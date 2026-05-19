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
import type { ValueCache, ValueScope } from "#backends/wasm/jit/codegen/emit/cache.js";
import type { ExitFrame } from "#backends/wasm/jit/codegen/emit/exit-frame.js";
import type {
  ValueCapture,
  ValueEmitter,
  ValueEmitters
} from "#backends/wasm/jit/codegen/emit/values.js";
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
import { passthroughValueCache } from "./value-local-store-test-helpers.js";

test("JIT memory guard emits address once and captures fault destination before guard checks", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const events: string[] = [];
  const address = constValue(0x60);
  const valueCache = passthroughValueCache();
  const at = placement();
  const values = recordingValues(body, events, new Map([[address, "address"]]), new Map(), valueCache).at(at);
  const memory = createMemoryEffectsEmitter({
    body,
    scratch,
    exitFrame: recordingExitFrame(body, events)
  });

  memory.emit({
    kind: "memoryGuard",
    at,
    address,
    byteLength: 4,
    access: "read",
    exit: memoryExit("read")
  }, values);
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
  const valueCache = passthroughValueCache();
  const at = placement();
  const values = recordingValues(body, [], new Map(), new Map(), valueCache).at(at);
  const memory = createMemoryEffectsEmitter({
    body,
    scratch: new WasmLocalScratchAllocator(body),
    exitFrame: recordingExitFrame(body, [])
  });

  throws(
    () => memory.emit({
      kind: "memoryGuard",
      at,
      address: constValue(0x60),
      byteLength: 4,
      access: "write",
      exit: memoryExit("read")
    }, values),
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
  const valueCache = passthroughValueCache();
  const at = placement();
  const values = recordingValues(body, events, labels, widths, valueCache).at(at);
  const memory = createMemoryEffectsEmitter({
    body,
    scratch,
    exitFrame: recordingExitFrame(body, events)
  });

  memory.emit({
    kind: "memoryStore",
    at,
    address,
    value,
    width: 32
  }, values);
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
  const valueCache = capturingValueCache(events, (emit) => {
    definedWidth = emit();
    return definedWidth;
  });
  const at = placement();
  const values = recordingValues(body, events, new Map([[address, "address"]]), new Map(), valueCache).at(at);
  const memory = createMemoryEffectsEmitter({
    body,
    scratch,
    exitFrame: recordingExitFrame(body, events)
  });

  memory.emit({
    kind: "memoryLoad",
    at,
    result: producedValue("load#memory-effects"),
    address,
    width: 8,
    signed: true
  }, values);
  scratch.assertClear();
  body.end();

  deepStrictEqual(events, [
    "define:load#memory-effects",
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
  const valueCache = decliningValueCache(events);
  const at = placement();
  const values = recordingValues(body, events, new Map(), new Map(), valueCache).at(at);
  const memory = createMemoryEffectsEmitter({
    body,
    scratch,
    exitFrame: recordingExitFrame(body, events)
  });

  memory.emit({
    kind: "memoryLoad",
    at,
    result: producedValue("load#unused"),
    address: constValue(0xa0),
    width: 32,
    signed: false
  }, values);
  scratch.assertClear();
  body.end();

  deepStrictEqual(events, ["define:load#unused"]);
  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Load), 0);
});

function recordingValues(
  body: WasmFunctionBodyEncoder,
  events: string[],
  labels: ReadonlyMap<JitValue, string>,
  widths: ReadonlyMap<JitValue, ValueWidth> = new Map(),
  valueCache: ValueCache & ValueScope = passthroughValueCache()
): ValueEmitters {
  const emit = (value: JitValue, options?: Parameters<ValueEmitter["emit"]>[1]) => {
    events.push(`value:${labels.get(value) ?? value.kind}:${options?.requestedWidth ?? "none"}`);
    body.i32Const(value.kind === "const" ? value.value : 0);
    return widths.get(value) ?? cleanValueWidth(32);
  };

  return {
    at: (at) => {
      const values: ValueEmitter = {
        emit,
        emitInline: emit,
        emitMasked: (value) => emit(value),
        retain: (value) => recordedValueCapture(body, valueCache.retain(value)),
        capture: (capture, emit) => requiredRecordedValueCapture(
          body,
          valueCache.withPath(capture.availability, () => valueCache.capture(capture, emit))
        ),
        define: (value, emit) => recordedValueCapture(body, valueCache.define(at, value, emit)),
        withPath: (path, emit) => valueCache.withPath(path, emit)
      };

      return values;
    }
  };
}

function recordedValueCapture(
  body: WasmFunctionBodyEncoder,
  captured: ReturnType<ValueCache["retain"]>
): ValueCapture | undefined {
  if (captured === undefined) {
    return undefined;
  }

  return {
    emit: () => {
      body.localGet(captured.local);
      return captured.valueWidth;
    },
    release: () => captured.release()
  };
}

function requiredRecordedValueCapture(
  body: WasmFunctionBodyEncoder,
  captured: ReturnType<ValueCache["capture"]>
): ValueCapture {
  const valueCapture = recordedValueCapture(body, captured);

  if (valueCapture === undefined) {
    throw new Error("expected recorded value capture");
  }

  return valueCapture;
}

function recordingExitFrame(
  body: WasmFunctionBodyEncoder,
  events: string[]
): ExitFrame {
  const exitLocal = body.addLocal(wasmValueType.i64);

  return {
    openDeferredBlocks: () => {},
    emitDeferredReturns: () => {},
    captureDestination: (_at, exit) => {
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
): ValueCache & ValueScope {
  return {
    withPath: (_path, emit) => emit(),
    emitForUse: () => {
      throw new Error("unexpected value cache use");
    },
    retain: () => undefined,
    capture: (planned, emit) => {
      const { value } = planned;
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
    define: (_at, value, emit) => {
      events.push(`define:${value.id}`);
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

function decliningValueCache(events: string[]): ValueCache & ValueScope {
  return {
    ...capturingValueCache(events, () => {
      throw new Error("unexpected value cache capture emission");
    }),
    define: (_at, value) => {
      events.push(`define:${value.id}`);
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
      progress: {
        instructionCountDelta: 0
      },
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
