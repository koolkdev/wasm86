import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { CompletionExit, encodeCompletionExit } from "#wasm/exit.js";
import type { LegacyHelperIndexRegistryAdapter } from "#wasm/helpers/registry.js";
import type { RmDecodeHelpers } from "./decode.js";
import { emitOpcodeDispatch } from "./dispatch.js";
import { emitOpcodeFetch } from "./fragments.js";
import type { InterpreterHandler } from "./handlers.js";
import { InterpreterLocals } from "./locals.js";
import { emitPrefixStateReset } from "./prefixes.js";

export function encodeRunLoopBody(
  rmDecode: RmDecodeHelpers,
  helpers: LegacyHelperIndexRegistryAdapter,
  handlers: InterpreterHandler[]
): EncodedWasmFunctionBody {
  const body = new WasmFunctionBodyEncoder(1);
  const locals = new InterpreterLocals(body);
  const scratch = new WasmLocalScratchAllocator(body);

  body.loop();
  body.localGet(fuelParam).i32Eqz().ifBlock();
  body.i64Const(encodeCompletionExit(CompletionExit.INSTRUCTION_LIMIT, 0)).returnFromFunction();
  body.endBlock();

  // Completed instructions land on this block's end; faults and unsupported
  // opcodes return from inside.
  body.block();
  emitOpcodeFetch({ body, scratch, helpers }, { eipLocal: locals.eip, byteLocal: locals.byte });
  // Fault paths commit the start; prefix cases rebase the eip local.
  body.localGet(locals.eip).localSet(locals.instructionStart);
  emitPrefixStateReset({ body, scratch, helpers, locals });
  // Prefix cases branch here to rescan with their prefix folded into locals.
  body.loop();
  emitOpcodeDispatch({ body, scratch, helpers, locals, handlers, continueDepth: 1, rmDecode });
  body.endBlock();
  body.endBlock();

  body.localGet(fuelParam).i32Const(1).i32Sub().localSet(fuelParam);
  body.br(0);
  body.endBlock();
  body.unreachable();
  scratch.assertClear();
  return body.finish();
}

const fuelParam = 0;
