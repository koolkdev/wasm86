import type {
  ExpandedInstructionSpec,
  MemOperandType,
  OperandSpec,
  RegOperandType,
  RmOperandType
} from "#x86/isa/schema/types.js";
import { registerAlias } from "#x86/isa/registers.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { SemanticOperandInfo } from "#x86/ir/model/types.js";
import type {
  InterpreterInstructionLength,
  InterpreterOperandBinding
} from "#backends/wasm/interpreter/codegen/ir-context.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { decodeModRmRmOperand } from "./address-decode.js";
import type { InterpreterAddressMode } from "./address-modes.js";
import {
  advanceDecodeReader,
  emitReadGuestByte,
  emitReadGuestUnsigned,
  instructionLengthFromDecodeReader,
  localDecodeReader,
  type DecodeReader
} from "./decode-reader.js";
import type { InterpreterHandlerContext } from "#backends/wasm/interpreter/codegen/handler-context.js";

export type DecodedInterpreterOperands = Readonly<{
  instructionLength: InterpreterInstructionLength;
  operands: readonly InterpreterOperandBinding[];
  scratchLocals: readonly number[];
}>;

export function decodeInstructionOperands(
  instruction: ExpandedInstructionSpec<unknown>,
  context: InterpreterHandlerContext,
  modRmLocal: number | undefined,
  addressModes: readonly InterpreterAddressMode[] = []
): DecodedInterpreterOperands {
  const operands: InterpreterOperandBinding[] = [];
  const scratchLocals: number[] = [];
  let reader: DecodeReader = decodeReaderAtOperandStart(context, instruction.opcode.length);

  if (modRmLocal !== undefined) {
    reader = advanceDecodeReader(reader, 1, context);
  }

  for (const [index, operand] of (instruction.spec.operands ?? []).entries()) {
    const decoded = decodeOperand(operand, reader, context, modRmLocal, addressModes[index] ?? "eager");

    operands.push(decoded.binding);
    scratchLocals.push(...decoded.scratchLocals);
    reader = decoded.nextReader;
  }

  return {
    instructionLength: instructionLengthFromDecodeReader(reader),
    operands,
    scratchLocals
  };
}

function decodeReaderAtOperandStart(context: InterpreterHandlerContext, opcodeLength: number): DecodeReader {
  if (context.opcodeOffset.kind === "static") {
    return { kind: "static", value: context.opcodeOffset.value + opcodeLength };
  }

  const reader = localDecodeReader(context.opcodeOffset.local);

  return advanceDecodeReader(reader, opcodeLength, context);
}

function decodeOperand(
  operand: OperandSpec,
  reader: DecodeReader,
  context: InterpreterHandlerContext,
  modRmLocal: number | undefined,
  addressMode: InterpreterAddressMode
): Readonly<{ binding: InterpreterOperandBinding; nextReader: DecodeReader; scratchLocals: readonly number[] }> {
  switch (operand.kind) {
    case "modrm.reg":
      if (modRmLocal === undefined) {
        throw new Error("missing ModRM local for modrm.reg operand");
      }

      return {
        binding: { kind: "modrm.reg", modRmLocal, width: operandTypeWidth(operand.type) },
        nextReader: reader,
        scratchLocals: []
      };
    case "modrm.rm":
      if (modRmLocal === undefined) {
        throw new Error("missing ModRM local for modrm.rm operand");
      }

      return mapNextReader(decodeModRmRmOperand(operand, reader, context, modRmLocal, addressMode));
    case "opcode.reg":
      return {
        binding: { kind: "opcode.reg", opcodeLocal: context.locals.opcode, width: operandTypeWidth(operand.type) },
        nextReader: reader,
        scratchLocals: []
      };
    case "implicit.reg":
      return {
        binding: { kind: "implicit.reg", alias: registerAlias(operand.reg) },
        nextReader: reader,
        scratchLocals: []
      };
    case "imm": {
      const local = context.scratch.allocLocal(wasmValueType.i32);

      emitLoadImmediate(operand, reader, context, local);
      return {
        binding: { kind: "imm", local },
        nextReader: advanceDecodeReader(reader, immediateByteLength(operand.width), context),
        scratchLocals: [local]
      };
    }
    case "rel": {
      const local = context.scratch.allocLocal(wasmValueType.i32);

      emitLoadRelativeTarget(operand, reader, context, local);
      return {
        binding: { kind: "relTarget", local },
        nextReader: advanceDecodeReader(reader, immediateByteLength(operand.width), context),
        scratchLocals: [local]
      };
    }
  }
}

export function interpreterSemanticOperandInfoForSpec(operand: OperandSpec): SemanticOperandInfo {
  switch (operand.kind) {
    case "modrm.reg":
    case "opcode.reg":
    case "implicit.reg":
      return { storage: "reg" };
    case "modrm.rm":
      return isMemoryOnlyOperandType(operand.type)
        ? { storage: "mem" }
        : { storage: "regOrMem" };
    case "imm":
      return { storage: "imm" };
    case "rel":
      return { storage: "relTarget" };
  }
}

function isMemoryOnlyOperandType(type: RmOperandType | MemOperandType): type is MemOperandType {
  switch (type) {
    case "m8":
    case "m16":
    case "m32":
      return true;
    case "rm8":
    case "rm16":
    case "rm32":
      return false;
  }
}

function mapNextReader(
  decoded: Readonly<{
    binding: InterpreterOperandBinding;
    nextDecodeReader: DecodeReader;
    scratchLocals: readonly number[];
  }>
): Readonly<{ binding: InterpreterOperandBinding; nextReader: DecodeReader; scratchLocals: readonly number[] }> {
  return {
    binding: decoded.binding,
    nextReader: decoded.nextDecodeReader,
    scratchLocals: decoded.scratchLocals
  };
}

function emitLoadImmediate(
  operand: Extract<OperandSpec, { kind: "imm" }>,
  reader: DecodeReader,
  context: InterpreterHandlerContext,
  local: number
): void {
  switch (operand.width) {
    case 8:
      emitReadGuestByte(context, reader, local);
      break;
    case 16:
      emitReadGuestUnsigned(context, reader, 16, local);
      break;
    case 32:
      emitReadGuestUnsigned(context, reader, 32, local);
      break;
  }

  if (operand.extension === "sign") {
    emitSignExtendLocal(context, local, operand.width);
  }
}

function emitLoadRelativeTarget(
  operand: Extract<OperandSpec, { kind: "rel" }>,
  reader: DecodeReader,
  context: InterpreterHandlerContext,
  local: number
): void {
  switch (operand.width) {
    case 8:
      emitReadGuestByte(context, reader, local);
      emitSignExtendLocal(context, local, 8);
      break;
    case 32:
      emitReadGuestUnsigned(context, reader, 32, local);
      break;
  }

  emitResolveRelativeTarget(context, local, reader, immediateByteLength(operand.width));
}

function emitResolveRelativeTarget(
  context: InterpreterHandlerContext,
  displacementLocal: number,
  displacementReader: DecodeReader,
  displacementByteLength: number
): void {
  emitNextEipForReader(context, displacementReader, displacementByteLength);
  context.body.localGet(displacementLocal).i32Add().localSet(displacementLocal);
}

function emitNextEipForReader(context: InterpreterHandlerContext, reader: DecodeReader, byteLength: number): void {
  context.body.localGet(context.locals.eip);

  if (reader.kind === "static") {
    context.body.i32Const(reader.value + byteLength);
  } else {
    context.body.localGet(reader.local).i32Const(byteLength).i32Add();
  }

  context.body.i32Add();
}

function emitSignExtendLocal(context: InterpreterHandlerContext, local: number, width: 8 | 16 | 32): void {
  if (width === 32) {
    return;
  }

  const signBit = width === 8 ? 0x80 : 0x8000;

  context.body.localGet(local).i32Const(signBit).i32Xor().i32Const(signBit).i32Sub().localSet(local);
}

function immediateByteLength(width: 8 | 16 | 32): number {
  return width / 8;
}

export function operandTypeWidth(type: RegOperandType | RmOperandType | MemOperandType): OperandWidth {
  switch (type) {
    case "r8":
    case "rm8":
    case "m8":
      return 8;
    case "r16":
    case "rm16":
    case "m16":
      return 16;
    case "r32":
    case "rm32":
    case "m32":
      return 32;
  }
}
