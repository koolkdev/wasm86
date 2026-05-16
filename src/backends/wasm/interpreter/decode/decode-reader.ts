import type { InterpreterInstructionLength } from "#backends/wasm/interpreter/codegen/ir-context.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import {
  emitLoadGuestByte,
  emitLoadGuestByteAtDynamicOffset,
  emitLoadGuestUnsigned,
  emitLoadGuestUnsignedAtDynamicOffset
} from "./guest-bytes.js";
import type { InterpreterHandlerContext } from "#backends/wasm/interpreter/codegen/handler-context.js";
import type { OperandWidth } from "#x86/isa/types.js";
import { maxX86InstructionLength } from "#x86/isa/decoder/reader.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { emitWasmIrExitFromI32Stack } from "#backends/wasm/codegen/exit.js";

export type DecodeReader =
  | Readonly<{ kind: "static"; value: number }>
  | Readonly<{ kind: "local"; local: number }>;

export function staticDecodeReader(value: number): DecodeReader {
  return { kind: "static", value };
}

export function localDecodeReader(local: number): DecodeReader {
  return { kind: "local", local };
}

export function instructionLengthFromDecodeReader(decodeReader: DecodeReader): InterpreterInstructionLength {
  return decodeReader.kind === "static" ? decodeReader.value : { kind: "local", local: decodeReader.local };
}

export function advanceDecodeReader(
  decodeReader: DecodeReader,
  byteCount: number,
  context: InterpreterHandlerContext
): DecodeReader {
  if (byteCount === 0) {
    return decodeReader;
  }

  if (decodeReader.kind === "static") {
    return staticDecodeReader(decodeReader.value + byteCount);
  }

  context.body.localGet(decodeReader.local).i32Const(byteCount).i32Add().localSet(decodeReader.local);
  return decodeReader;
}

export function materializeDecodeReader(decodeReader: DecodeReader, context: InterpreterHandlerContext): number {
  const local = context.scratch.allocLocal(wasmValueType.i32);

  if (decodeReader.kind === "static") {
    context.body.i32Const(decodeReader.value).localSet(local);
  } else {
    context.body.localGet(decodeReader.local).localSet(local);
  }

  return local;
}

export function emitReadGuestByte(
  context: InterpreterHandlerContext,
  decodeReader: DecodeReader,
  local: number
): void {
  if (emitFaultIfInstructionReadTooLong(context, decodeReader, 1)) {
    return;
  }

  if (decodeReader.kind === "static") {
    emitLoadGuestByte(context.body, context.locals.eip, decodeReader.value, context.locals.address, local, context.exit);
    return;
  }

  emitLoadGuestByteAtDynamicOffset(
    context.body,
    context.locals.eip,
    decodeReader.local,
    context.locals.address,
    local,
    context.exit
  );
}

export function emitReadGuestUnsigned(
  context: InterpreterHandlerContext,
  decodeReader: DecodeReader,
  width: OperandWidth,
  local: number
): void {
  if (emitFaultIfInstructionReadTooLong(context, decodeReader, instructionReadByteLength(width))) {
    return;
  }

  if (decodeReader.kind === "static") {
    emitLoadGuestUnsigned(
      context.body,
      context.locals.eip,
      decodeReader.value,
      width,
      context.locals.address,
      local,
      context.exit
    );
    return;
  }

  emitLoadGuestUnsignedAtDynamicOffset(
    context.body,
    context.locals.eip,
    decodeReader.local,
    width,
    context.locals.address,
    local,
    context.exit
  );
}

export function emitReadGuestByteAtRelativeOffset(
  context: InterpreterHandlerContext,
  decodeReader: DecodeReader,
  byteOffset: number,
  local: number
): void {
  if (byteOffset === 0) {
    emitReadGuestByte(context, decodeReader, local);
    return;
  }

  if (decodeReader.kind === "static") {
    emitReadGuestByte(context, staticDecodeReader(decodeReader.value + byteOffset), local);
    return;
  }

  const offsetLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    context.body.localGet(decodeReader.local).i32Const(byteOffset).i32Add().localSet(offsetLocal);
    emitReadGuestByte(context, localDecodeReader(offsetLocal), local);
  } finally {
    context.scratch.freeLocal(offsetLocal);
  }
}

function emitFaultIfInstructionReadTooLong(
  context: InterpreterHandlerContext,
  decodeReader: DecodeReader,
  byteLength: number
): boolean {
  if (decodeReader.kind === "static") {
    if (decodeReader.value + byteLength <= maxX86InstructionLength) {
      return false;
    }

    emitInstructionTooLongFault(context, 0);
    return true;
  }

  context.body
    .localGet(decodeReader.local)
    .i32Const(maxX86InstructionLength - byteLength)
    .i32GtU()
    .ifBlock();
  emitInstructionTooLongFault(context, 1);
  context.body.endBlock();
  return false;
}

function emitInstructionTooLongFault(context: InterpreterHandlerContext, extraDepth: number): void {
  context.body.localGet(context.locals.eip).i32Const(maxX86InstructionLength).i32Add();
  emitWasmIrExitFromI32Stack(context.body, {
    destination: context.exit,
    reason: ExitReason.DECODE_FAULT,
    extraDepth
  });
}

function instructionReadByteLength(width: OperandWidth): 1 | 2 | 4 {
  return width === 8 ? 1 : width === 16 ? 2 : 4;
}
