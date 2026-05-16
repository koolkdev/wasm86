import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { WasmIrExitDestination } from "#backends/wasm/codegen/exit.js";
import type { InterpreterStateCache } from "./state-cache.js";
import type { DecodeReader } from "#backends/wasm/interpreter/decode/decode-reader.js";
import type { OperandSizePrefixMode } from "#x86/isa/schema/types.js";
import type { InterpreterLocals } from "./locals.js";
import type { InterpreterDispatchDepths } from "./depths.js";

export type InterpreterHandlerContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  state: InterpreterStateCache;
  locals: InterpreterLocals;
  depths: InterpreterDispatchDepths;
  exit: WasmIrExitDestination;
  opcodeOffset: DecodeReader;
  operandSize: OperandSizePrefixMode;
}>;
