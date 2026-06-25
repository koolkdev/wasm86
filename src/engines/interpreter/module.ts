import { assert } from "#common/assert.js";
import { wasmBlockExportName, wasmGuestMemoryMinPages, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import { createWasmHelperRegistry, defineAllHelpers, type WasmHelperRegistry } from "#wasm/helpers/module.js";
import { RmDecodeHelpers } from "./decode.js";
import { emitOpcodeDispatch } from "./dispatch.js";
import { emitOpcodeFetch } from "./fragments.js";
import type { InterpreterHandler } from "./handlers.js";
import { InterpreterLocals } from "./locals.js";

// The interpreter module: a hand-written fuel loop around the dispatch.
// State stays memory-backed — fault and unsupported exits return directly
// with everything already observable, and handler blocks advance the
// instruction count themselves.

const fuelParam = 0;

export type InterpreterModule = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  // One entry per emitted handler body, in emission order.
  handlers: readonly InterpreterHandler[];
  // Opcode lengths with an emitted shared rm-decode helper, in emission order.
  rmDecodeHelpers: readonly number[];
}>;

export function encodeInterpreterModule(): InterpreterModule {
  const module = new WasmModuleEncoder();

  importInterpreterMemories(module);

  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });
  const rmDecode = new RmDecodeHelpers(module);
  const helpers = createWasmHelperRegistry(module);

  defineAllHelpers(helpers);

  // Emitting the run loop adds the rm-decode helpers it uses to the module.
  const { body, handlers } = encodeRunLoopBody(rmDecode, helpers);
  const functionIndex = module.addFunction(typeIndex, body);

  module.exportFunction(wasmBlockExportName, functionIndex);
  return { bytes: module.encode(), handlers, rmDecodeHelpers: rmDecode.emittedOpcodeLengths() };
}

function importInterpreterMemories(module: WasmModuleEncoder): void {
  const cpuStateMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.cpuStateMemoryName, {
    minPages: 1
  });
  const guestMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.guestMemoryName, {
    minPages: wasmGuestMemoryMinPages
  });

  assert(
    cpuStateMemoryIndex === wasmMemoryIndex.cpuState && guestMemoryIndex === wasmMemoryIndex.guest,
    "unexpected Wasm memory import order"
  );
}

function encodeRunLoopBody(
  rmDecode: RmDecodeHelpers,
  helpers: WasmHelperRegistry
): Readonly<{ body: WasmFunctionBodyEncoder; handlers: InterpreterHandler[] }> {
  const body = new WasmFunctionBodyEncoder(1);
  const locals = new InterpreterLocals(body);
  const scratch = new WasmLocalScratchAllocator(body);
  const handlers: InterpreterHandler[] = [];

  body.loop();
  body.localGet(fuelParam).i32Eqz().ifBlock();
  body.i64Const(encodeExit(ExitReason.INSTRUCTION_LIMIT, 0)).returnFromFunction();
  body.endBlock();

  // Completed instructions land on this block's end; faults and unsupported
  // opcodes return from inside.
  body.block();
  emitOpcodeFetch({ body, scratch, helpers }, { eipLocal: locals.eip, byteLocal: locals.byte });
  emitOpcodeDispatch({ body, scratch, helpers, locals, handlers, continueDepth: 0, rmDecode });
  body.endBlock();

  body.localGet(fuelParam).i32Const(1).i32Sub().localSet(fuelParam);
  body.br(0);
  body.endBlock();
  body.unreachable();
  scratch.assertClear();
  return { body: body.end(), handlers };
}
