import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { dispatchBytes, interpreterOpcodeDispatchRoot } from "./dispatch.js";
import { emitWasmIrExitConstPayload, type WasmIrExitDestination } from "#backends/wasm/codegen/exit.js";
import { emitInstructionHandlerForLeaf } from "./instruction-handlers.js";
import type { InterpreterStateCache } from "#backends/wasm/interpreter/codegen/state-cache.js";
import {
  emitReadGuestByte,
  emitReadGuestByteAtRelativeOffset,
  localDecodeReader,
  staticDecodeReader,
  type DecodeReader
} from "#backends/wasm/interpreter/decode/decode-reader.js";
import type { OperandSizePrefixMode } from "#x86/isa/schema/types.js";
import type { InterpreterLocals } from "#backends/wasm/interpreter/codegen/locals.js";
import { InterpreterDispatchDepths } from "#backends/wasm/interpreter/codegen/depths.js";

type OpcodeDispatchContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  state: InterpreterStateCache;
  locals: InterpreterLocals;
  depths: InterpreterDispatchDepths;
  exit: WasmIrExitDestination;
  opcodeOffset: DecodeReader;
  operandSize: OperandSizePrefixMode;
  scratch: WasmLocalScratchAllocator;
}>;

const operandSizeOverridePrefix = 0x66;

export function emitOpcodeDispatch(
  body: WasmFunctionBodyEncoder,
  state: InterpreterStateCache,
  exit: WasmIrExitDestination,
  locals: InterpreterLocals,
  scratch: WasmLocalScratchAllocator
): void {
  body.localGet(locals.byte).localSet(locals.opcode);
  emitOpcodeDispatchNode(interpreterOpcodeDispatchRoot, {
    body,
    state,
    locals,
    depths: InterpreterDispatchDepths.root(),
    exit,
    opcodeOffset: staticDecodeReader(0),
    operandSize: "default",
    scratch
  });
}

function emitOpcodeDispatchNode(node: typeof interpreterOpcodeDispatchRoot, context: OpcodeDispatchContext): void {
  const bytes = dispatchBytesForContext(node, context);

  if (bytes.length === 0) {
    emitUnsupportedOpcodeExit(context);
    return;
  }

  context.body.block();

  for (const _byte of bytes) {
    context.body.block();
  }

  context.body.localGet(context.locals.byte).brTable(dispatchTable(bytes), bytes.length);

  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index];

    if (byte === undefined) {
      continue;
    }

    const child = node.next[byte];

    if (child === undefined && !isOperandSizePrefixCase(byte, context)) {
      continue;
    }

    context.body.endBlock();

    const caseContext = {
      ...context,
      depths: context.depths.caseBranch(index),
      exit: {
        ...context.exit,
        labelDepth: context.exit.labelDepth + 1 + index
      }
    };

    if (isOperandSizePrefixCase(byte, context)) {
      emitOperandSizePrefixCase(caseContext);
    } else if (child?.leaf !== undefined) {
      const emitted = emitInstructionHandlerForLeaf(child.leaf, caseContext);

      if (!emitted) {
        emitUnsupportedOpcodeExit(caseContext);
      }
    } else {
      emitLoadOpcodeByte(caseContext, 1);
      context.body.localGet(context.locals.byte).localSet(context.locals.opcode);
      emitOpcodeDispatchNode(
        child!,
        {
          ...caseContext,
          depths: caseContext.depths.opcodeChild()
        }
      );
      emitUnsupportedOpcodeExit(caseContext);
    }
  }

  context.body.endBlock();
  emitUnsupportedOpcodeExit(context);
}

function emitUnsupportedOpcodeExit(context: OpcodeDispatchContext): void {
  emitWasmIrExitConstPayload(context.body, {
    destination: context.exit,
    reason: ExitReason.UNSUPPORTED,
    payload: 0
  });
}

function emitOperandSizePrefixCase(context: OpcodeDispatchContext): void {
  materializeNextOpcodeOffset(context);
  emitLoadOpcodeByte(
    {
      ...context,
      opcodeOffset: localDecodeReader(context.locals.opcodeOffset),
      depths: context.depths.opcodeRoot()
    },
    0
  );
  context.body.localGet(context.locals.byte).localSet(context.locals.opcode);

  if (context.depths.prefixLoop !== undefined) {
    context.body.br(context.depths.prefixLoop);
    return;
  }

  context.body.loop();
  emitOpcodeDispatchNode(interpreterOpcodeDispatchRoot, {
    ...context,
    exit: {
      ...context.exit,
      labelDepth: context.exit.labelDepth + 1
    },
    opcodeOffset: localDecodeReader(context.locals.opcodeOffset),
    operandSize: "override",
    depths: context.depths.prefixLoopBody()
  });
  context.body.endBlock();
}

function materializeNextOpcodeOffset(context: OpcodeDispatchContext): void {
  if (context.opcodeOffset.kind === "static") {
    context.body.i32Const(context.opcodeOffset.value + 1);
  } else {
    context.body.localGet(context.opcodeOffset.local).i32Const(1).i32Add();
  }

  context.body.localSet(context.locals.opcodeOffset);
}

function emitLoadOpcodeByte(context: OpcodeDispatchContext, depth: number): void {
  if (depth === 0) {
    emitReadGuestByte(context, context.opcodeOffset, context.locals.byte);
    return;
  }

  emitReadGuestByteAtRelativeOffset(context, context.opcodeOffset, depth, context.locals.byte);
}

function dispatchBytesForContext(node: typeof interpreterOpcodeDispatchRoot, context: OpcodeDispatchContext): number[] {
  const bytes = dispatchBytes(node);

  if (!canDispatchOperandSizePrefix(context) || bytes.includes(operandSizeOverridePrefix)) {
    return bytes;
  }

  return [...bytes, operandSizeOverridePrefix];
}

function canDispatchOperandSizePrefix(context: OpcodeDispatchContext): boolean {
  return context.depths.opcode === 0;
}

function isOperandSizePrefixCase(byte: number, context: OpcodeDispatchContext): boolean {
  return byte === operandSizeOverridePrefix && canDispatchOperandSizePrefix(context);
}

function dispatchTable(bytes: readonly number[]): number[] {
  const table = new Array<number>(256).fill(bytes.length);

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];

    if (byte !== undefined) {
      table[byte] = bytes.length - 1 - index;
    }
  }

  return table;
}
