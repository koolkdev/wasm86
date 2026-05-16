import { throws } from "node:assert";
import {
  deepStrictEqual,
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  wasmOpcode,
  stateOffset,
  wasmBodyMemoryAccesses,
  wasmBodyOpcodes,
  createExitMetadataEmitter,
  exitState
} from "./value-local-store-test-helpers.js";
import { wasmMemoryIndex } from "#backends/wasm/abi.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { rootPath } from "#backends/wasm/jit/analysis/paths.js";
import type { Exit } from "#backends/wasm/jit/codegen/plan/types.js";

test("JIT exit metadata applies exact exit instruction-count delta", () => {
  const body = new WasmFunctionBodyEncoder();
  const metadata = createExitMetadataEmitter(body);

  metadata.beginBlock();
  metadata.emit(exitWithMetadata({
    visibleEip: { kind: "static", value: 0x2000 },
    instructionCountDelta: 3
  }));
  body.end();

  strictEqual(wasmBodyOpcodes(body.encode()).includes(wasmOpcode.i32Add), true);
  deepStrictEqual(metadataStoreOffsets(body.encode()), [
    stateOffset.eip,
    stateOffset.instructionCount
  ]);
});

test("JIT exit metadata requires runtime visible EIP callback", () => {
  const body = new WasmFunctionBodyEncoder();
  const metadata = createExitMetadataEmitter(body);
  const exit = exitWithMetadata({
    visibleEip: { kind: "runtime", source: "controlTarget" },
    instructionCountDelta: 1
  });

  metadata.beginBlock();
  throws(() => metadata.emit(exit), /JIT runtime visible EIP requested without an emitter/);
});

test("JIT exit metadata accepts explicit runtime visible EIP callback", () => {
  const body = new WasmFunctionBodyEncoder();
  const metadata = createExitMetadataEmitter(body);
  const exit = exitWithMetadata({
    visibleEip: { kind: "runtime", source: "controlTarget" },
    instructionCountDelta: 1
  });

  metadata.beginBlock();
  metadata.emit(exit, {
    emitRuntimeVisibleEip: () => {
      body.i32Const(0x2000);
    }
  });
  body.end();

  deepStrictEqual(metadataStoreOffsets(body.encode()), [
    stateOffset.eip,
    stateOffset.instructionCount
  ]);
});

function metadataStoreOffsets(
  body: Uint8Array<ArrayBuffer>
): readonly number[] {
  return wasmBodyMemoryAccesses(body)
    .filter((access) =>
      access.memoryIndex === wasmMemoryIndex.state &&
        access.opcode === wasmOpcode.i32Store
    )
    .map((access) => access.offset);
}

function exitWithMetadata(
  input: Readonly<{
    visibleEip: Exit["visibleEip"];
    instructionCountDelta: number;
  }>
): Exit {
  return {
    id: "0:0:jump",
    at: { instructionIndex: 0, opIndex: 0 },
    kind: "jump",
    reason: ExitReason.JUMP,
    snapshot: exitState(input.instructionCountDelta),
    visibleEip: input.visibleEip,
    payload: input.visibleEip,
    path: rootPath()
  };
}
