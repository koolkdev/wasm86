import { assert } from "#common/assert.js";
import type { ActionBlock, ActionExitReason, ExitAction } from "#ir/action/types.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import { emitChannelLoad, emitChannelStore } from "./state.js";
import { createValueStack } from "./value-stack.js";
import { analyzeRegionValues } from "./values.js";

// The emitter driver: walks an ActionBlock in action order and fills the
// given function body. Its product is a function body, never a module —
// module assembly (imports, exports, ABI) belongs to the backends; the only
// module wrapping under emit/action is the test harness.

export type ActionEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
}>;

export function emitActionBlock(block: ActionBlock, context: ActionEmitContext): WasmFunctionBodyEncoder {
  // Regions beyond the entry arrive with fault edges; nothing emits them yet.
  assert(block.regions.length === 1, "action emitter supports only a single region");

  const region = block.regions[0]!;

  assert(region.id === block.entry && region.kind === "entry", "action block region is not its entry");

  const terminator = region.actions[region.actions.length - 1];

  assert(terminator?.kind === "exit", "action region does not terminate with an exit");

  const { body } = context;
  const scratch = new WasmLocalScratchAllocator(body);
  const valueStack = createValueStack({
    body,
    scratch,
    values: block.values,
    analysis: analyzeRegionValues(region, block.values),
    // Nothing binds external values yet: blocks come from the builder, which
    // rejects external operand bindings.
    externalLocals: new Map(),
    loadSlot: (slot, signed) => emitChannelLoad(body, slot, signed)
  });

  for (const action of region.actions) {
    switch (action.kind) {
      case "readState":
        valueStack.readState(action);
        break;
      case "writeState":
        emitChannelStore(body, action.slot, () => valueStack.emitUse(action.value));
        break;
      case "exit":
        emitExit(body, action);
        break;
      default:
        throw new Error(`${action.kind} not supported by action emitter yet`);
    }
  }

  valueStack.assertClear();
  scratch.assertClear();
  return body.end();
}

// The default exit lowering: return the encoded i64 exit. Embeddings with
// other strategies (fall through, br to a loop head) configure it later.
function emitExit(body: WasmFunctionBodyEncoder, action: ExitAction): void {
  if (action.payload !== undefined) {
    throw new Error("exit payload not supported by action emitter yet");
  }

  body.i64Const(encodeExit(exitReasonCode(action.reason), 0)).returnFromFunction();
}

// ir/action names exit reasons; the emitter owns the numeric encoding.
function exitReasonCode(reason: ActionExitReason): ExitReason {
  switch (reason) {
    case "next":
      return ExitReason.FALLTHROUGH;
    case "jump":
      return ExitReason.JUMP;
    case "hostTrap":
      return ExitReason.HOST_TRAP;
    case "unsupported":
      return ExitReason.UNSUPPORTED;
    case "decodeFault":
      return ExitReason.DECODE_FAULT;
    case "memoryReadFault":
      return ExitReason.MEMORY_READ_FAULT;
    case "memoryWriteFault":
      return ExitReason.MEMORY_WRITE_FAULT;
  }
}
