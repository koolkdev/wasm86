import { assert } from "#common/assert.js";
import { wasmBlockExportName, wasmGuestMemoryMinPages, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import { RmDecodeHelpers } from "./decode.js";
import { emitActionOpcodeDispatch } from "./dispatch.js";
import { emitOpcodeFetch } from "./fragments.js";
import type { ActionInterpreterHandler } from "./handlers.js";
import { ActionInterpreterLocals } from "./locals.js";

// The action interpreter module: a hand-written fuel loop and instruction
// counting around the dispatch. State stays memory-backed — fault and
// unsupported exits return directly with everything already observable.

const fuelParam = 0;

export type ActionInterpreterModule = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  // One entry per emitted handler body, in emission order.
  handlers: readonly ActionInterpreterHandler[];
  // Opcode lengths with an emitted shared rm-decode helper, in emission order.
  rmDecodeHelpers: readonly number[];
}>;

export function encodeActionInterpreterModule(): ActionInterpreterModule {
  const module = new WasmModuleEncoder();

  importInterpreterMemories(module);

  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });
  const rmDecode = new RmDecodeHelpers(module);
  // Emitting the run loop adds the rm-decode helpers it uses to the module.
  const { body, handlers } = encodeRunLoopBody(rmDecode);
  const functionIndex = module.addFunction(typeIndex, body);

  module.exportFunction(wasmBlockExportName, functionIndex);
  return { bytes: module.encode(), handlers, rmDecodeHelpers: rmDecode.emittedOpcodeLengths() };
}

function importInterpreterMemories(module: WasmModuleEncoder): void {
  const stateMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, {
    minPages: 1
  });
  const guestMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.guestMemoryName, {
    minPages: wasmGuestMemoryMinPages
  });

  assert(
    stateMemoryIndex === wasmMemoryIndex.state && guestMemoryIndex === wasmMemoryIndex.guest,
    "unexpected Wasm memory import order"
  );
}

function encodeRunLoopBody(
  rmDecode: RmDecodeHelpers
): Readonly<{ body: WasmFunctionBodyEncoder; handlers: ActionInterpreterHandler[] }> {
  const body = new WasmFunctionBodyEncoder(1);
  const locals = new ActionInterpreterLocals(body);
  const scratch = new WasmLocalScratchAllocator(body);
  const handlers: ActionInterpreterHandler[] = [];

  body.loop();
  body.localGet(fuelParam).i32Eqz().ifBlock();
  body.i64Const(encodeExit(ExitReason.INSTRUCTION_LIMIT, 0)).returnFromFunction();
  body.endBlock();

  // Completed instructions land on this block's end; handler blocks advance
  // the instruction count themselves.
  body.block();
  emitOpcodeFetch({ body, scratch }, { eipLocal: locals.eip, byteLocal: locals.byte });
  emitActionOpcodeDispatch({ body, scratch, locals, handlers, continueDepth: 0, rmDecode });
  body.endBlock();

  body.localGet(fuelParam).i32Const(1).i32Sub().localSet(fuelParam);
  body.br(0);
  body.endBlock();
  body.unreachable();
  scratch.assertClear();
  return { body: body.end(), handlers };
}
