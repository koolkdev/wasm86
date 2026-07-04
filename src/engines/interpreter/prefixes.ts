import { assert } from "#common/assert.js";
import { operandSizeOverridePrefixByte, segmentOverridePrefixSegments } from "#x86/prefixes.js";
import { noSegmentOverride, segmentRegisterIndex } from "#x86/segments.js";
import type { SegmentRegister } from "#x86/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmHelperRegistry } from "#wasm/helpers/module.js";
import { emitOpcodeByteFetch } from "./fragments.js";
import type { InterpreterLocals } from "./locals.js";

// Prefix bytes are first-byte dispatch cases: each writes its prefix state,
// consumes the byte — advance the eip local, fetch the next — and branches
// back to the dispatch loop to rescan. Dispatch reaches the opcode with the
// eip local rebased to it and every prefix folded into locals; CPU-state
// EIP stays untouched, and the saved instruction start serves handler
// fault paths.

export const operandSizeFlagBit = 1 << 0;

export type PrefixEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  helpers: WasmHelperRegistry;
  locals: InterpreterLocals;
}>;

// A handler writes prefix state only; the shared case tail owns eip/byte.
type PrefixHandler = Readonly<{
  byte: number;
  emitEffect(context: PrefixEmitContext): void;
}>;

const prefixHandlers: readonly PrefixHandler[] = [
  ...[...segmentOverridePrefixSegments].map(([byte, reg]) => segmentOverridePrefix(byte, reg)),
  {
    // Operand-size override.
    byte: operandSizeOverridePrefixByte,
    emitEffect: ({ body, locals }) => {
      body.localGet(locals.prefixFlags).i32Const(operandSizeFlagBit).i32Or().localSet(locals.prefixFlags);
    }
  }
];

// The bytes dispatch adds as first-byte cases.
export const prefixBytes: readonly number[] = prefixHandlers.map((handler) => handler.byte);

// Locals persist across run-loop iterations; every instruction starts clean.
export function emitPrefixStateReset(context: PrefixEmitContext): void {
  context.body.i32Const(0).localSet(context.locals.prefixFlags);
  context.body.i32Const(noSegmentOverride).localSet(context.locals.segment);
}

export function emitPrefixCase(byte: number, redispatchDepth: number, context: PrefixEmitContext): void {
  const { body, locals } = context;
  const handler = prefixHandlers.find((candidate) => candidate.byte === byte);

  assert(handler !== undefined, `no prefix handler for byte 0x${byte.toString(16)}`);
  handler.emitEffect(context);
  body.localGet(locals.eip).i32Const(1).i32Add().localSet(locals.eip);
  emitOpcodeByteFetch(context, locals.eip, 0, locals.byte);
  body.br(redispatchDepth);
}

function segmentOverridePrefix(byte: number, reg: SegmentRegister): PrefixHandler {
  const index = segmentRegisterIndex(reg);

  return {
    byte,
    emitEffect: ({ body, locals }) => {
      body.i32Const(index).localSet(locals.segment);
    }
  };
}
