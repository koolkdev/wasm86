import { assert } from "#common/assert.js";
import type { IrBlock } from "#ir/block.js";
import { wasmBlockExportName, wasmGuestMemoryMinPages, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import { analyzePlacement, type BlockPlacement } from "#wasm/emit/placement.js";
import {
  createWasmHelperRegistry,
  defineRequiredHelpers,
  helperCallsForBlock,
  type WasmHelperRegistry
} from "#wasm/helpers/module.js";

// Test-only module wrapper around the action emitter: imported state + guest
// memories, one run export returning the encoded i64 exit. The harness
// embeds like any host: dispatch escapes through an explicit block branch,
// bare action-body fallthrough reaches the sentinel tail lexically, and
// reports return their real encoded exits. External value n is the
// function's n-th i32 parameter. Module assembly for real use is the
// engines' job.

// No encoded exit equals the sentinel: its reason field is 0xffff.
export const irBlockCompleted = -1n;

export type InstantiatedIrBlock = Readonly<{
  stateView: DataView;
  guestView: DataView;
  run(...externals: number[]): bigint;
}>;

// The fragment with direct exits to the sentinel tail.
export function irBlockBody(block: IrBlock, externalParamCount = 0): WasmFunctionBodyEncoder {
  return emitIrBlockBody(block, externalParamCount);
}

export function irBlockBodyWithHelpers(block: IrBlock, externalParamCount = 0): WasmFunctionBodyEncoder {
  const module = new WasmModuleEncoder();
  const placement = analyzePlacement(block);
  const helpers = createWasmHelperRegistry(module);

  defineRequiredHelpers(helpers, helperCallsForBlock(block, placement));
  return emitIrBlockBody(block, externalParamCount, helpers, placement);
}

function emitIrBlockBody(
  block: IrBlock,
  externalParamCount: number,
  helpers?: WasmHelperRegistry,
  placement?: BlockPlacement
): WasmFunctionBodyEncoder {
  const body = new WasmFunctionBodyEncoder(externalParamCount);
  const scratch = new WasmLocalScratchAllocator(body);

  body.block();
  emitActionFragment(block, {
    body,
    scratch,
    externalLocals: new Map(Array.from({ length: externalParamCount }, (_, id) => [id, id])),
    helpers,
    placement,
    embedding: {
      dispatch: { kind: "br", depth: 0 },
      fallthrough: { kind: "fallthrough" }
    }
  });
  body.endBlock();
  scratch.assertClear();
  return body.i64Const(irBlockCompleted).end();
}

export async function instantiateIrBlock(
  block: IrBlock,
  externalParamCount = 0
): Promise<InstantiatedIrBlock> {
  const state = new WebAssembly.Memory({ initial: 1 });
  const guest = new WebAssembly.Memory({ initial: wasmGuestMemoryMinPages });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeIrBlockModule(block, externalParamCount)),
    {
      [wasmImport.namespace]: {
        [wasmImport.cpuStateMemoryName]: state,
        [wasmImport.guestMemoryName]: guest
      }
    }
  );
  const run = instance.exports[wasmBlockExportName];

  assert(typeof run === "function", `missing Wasm ${wasmBlockExportName} export`);

  return {
    stateView: new DataView(state.buffer),
    guestView: new DataView(guest.buffer),
    run: (...externals) => (run as (...args: number[]) => bigint)(...externals)
  };
}

// Same wrapper around an already finished body — typically a hand-written
// embedder function with fragments emitted inline.
export async function instantiateFunctionBody(
  body: WasmFunctionBodyEncoder,
  paramCount = 0
): Promise<InstantiatedIrBlock> {
  const state = new WebAssembly.Memory({ initial: 1 });
  const guest = new WebAssembly.Memory({ initial: wasmGuestMemoryMinPages });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeFunctionBodyModule(body, paramCount)),
    {
      [wasmImport.namespace]: {
        [wasmImport.cpuStateMemoryName]: state,
        [wasmImport.guestMemoryName]: guest
      }
    }
  );
  const run = instance.exports[wasmBlockExportName];

  assert(typeof run === "function", `missing Wasm ${wasmBlockExportName} export`);

  return {
    stateView: new DataView(state.buffer),
    guestView: new DataView(guest.buffer),
    run: (...externals) => (run as (...args: number[]) => bigint)(...externals)
  };
}

function encodeFunctionBodyModule(body: WasmFunctionBodyEncoder, paramCount: number): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = initializeTestModule(module, paramCount);

  module.exportFunction(wasmBlockExportName, module.addFunction(typeIndex, body));
  return module.encode();
}

function encodeIrBlockModule(block: IrBlock, externalParamCount: number): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = initializeTestModule(module, externalParamCount);
  const placement = analyzePlacement(block);
  const helpers = createWasmHelperRegistry(module);

  defineRequiredHelpers(helpers, helperCallsForBlock(block, placement));
  module.exportFunction(
    wasmBlockExportName,
    module.addFunction(typeIndex, emitIrBlockBody(block, externalParamCount, helpers, placement))
  );
  return module.encode();
}

function initializeTestModule(module: WasmModuleEncoder, paramCount: number): number {
  const cpuStateMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.cpuStateMemoryName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.guestMemoryName, {
    minPages: wasmGuestMemoryMinPages
  });

  assert(
    cpuStateMemoryIndex === wasmMemoryIndex.cpuState && guestMemoryIndex === wasmMemoryIndex.guest,
    "unexpected Wasm memory import order"
  );

  const typeIndex = module.addFunctionType({
    params: Array.from({ length: paramCount }, () => wasmValueType.i32),
    results: [wasmValueType.i64]
  });

  return typeIndex;
}
