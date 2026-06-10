import { assert } from "#common/assert.js";
import type { ActionBlock } from "#ir/action/types.js";
import { wasmBlockExportName, wasmGuestMemoryMinPages, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { emitActionBlock } from "#wasm/emit/action/emit.js";

// Test-only module wrapper around the action emitter: imported state + guest
// memories, one run export returning the encoded i64 exit. Module assembly
// for real use is the backends' job.

export type InstantiatedActionBlock = Readonly<{
  stateView: DataView;
  guestView: DataView;
  run(): bigint;
}>;

export async function instantiateActionBlock(block: ActionBlock): Promise<InstantiatedActionBlock> {
  const state = new WebAssembly.Memory({ initial: 1 });
  const guest = new WebAssembly.Memory({ initial: wasmGuestMemoryMinPages });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeActionBlockModule(block)),
    {
      [wasmImport.moduleName]: {
        [wasmImport.stateMemoryName]: state,
        [wasmImport.guestMemoryName]: guest
      }
    }
  );
  const run = instance.exports[wasmBlockExportName];

  assert(typeof run === "function", `missing Wasm ${wasmBlockExportName} export`);

  return {
    stateView: new DataView(state.buffer),
    guestView: new DataView(guest.buffer),
    run: () => (run as () => bigint)()
  };
}

function encodeActionBlockModule(block: ActionBlock): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const stateMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.guestMemoryName, {
    minPages: wasmGuestMemoryMinPages
  });

  assert(
    stateMemoryIndex === wasmMemoryIndex.state && guestMemoryIndex === wasmMemoryIndex.guest,
    "unexpected Wasm memory import order"
  );

  const typeIndex = module.addFunctionType({ params: [], results: [wasmValueType.i64] });
  const body = emitActionBlock(block, { body: new WasmFunctionBodyEncoder() });

  module.exportFunction(wasmBlockExportName, module.addFunction(typeIndex, body));
  return module.encode();
}
