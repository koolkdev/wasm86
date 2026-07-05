import { u32 } from "#x86/numeric.js";
import { X86_32_CORE } from "#x86/index.js";
import { decodeIsaInstructionFromReader } from "./decode.js";
import {
  truncatedInstructionFault,
  IsaDecodeError,
  readAvailableBytes,
  type IsaDecodeFault,
  type IsaDecodeReader
} from "./reader.js";
import type { IsaDecodedInstruction } from "./types.js";

export type IsaDecodedBlock = Readonly<{
  startEip: number;
  instructions: readonly IsaDecodedInstruction[];
  terminator: IsaBlockTerminator;
}>;

export type IsaBlockTerminator =
  | Readonly<{ kind: "fallthrough"; nextEip: number }>
  | Readonly<{ kind: "control"; instruction: IsaDecodedInstruction }>
  | Readonly<{
      kind: "unsupported";
      address: number;
      length: number;
      raw: readonly number[];
      unsupportedByte?: number;
    }>
  | Readonly<{ kind: "decode-fault"; fault: IsaDecodeFault }>;

export type DecodeIsaBlockOptions = Readonly<{
  maxInstructions?: number;
}>;

const defaultMaxInstructions = 64;

export function decodeIsaBlock(
  reader: IsaDecodeReader,
  startEip: number,
  options: DecodeIsaBlockOptions = {}
): IsaDecodedBlock {
  const instructions: IsaDecodedInstruction[] = [];
  const maxInstructions = options.maxInstructions ?? defaultMaxInstructions;
  let eip = u32(startEip);

  for (let count = 0; count < maxInstructions; count += 1) {
    const decoded = decodeInstruction(reader, eip);

    if (decoded.kind === "decode-fault") {
      return { startEip, instructions, terminator: decoded };
    }

    if (decoded.kind === "unsupported") {
      return { startEip, instructions, terminator: decoded };
    }

    instructions.push(decoded.instruction);

    if (shouldEndDecodedBlock(decoded.instruction)) {
      return { startEip, instructions, terminator: { kind: "control", instruction: decoded.instruction } };
    }

    eip = decoded.instruction.nextEip;
  }

  return { startEip, instructions, terminator: { kind: "fallthrough", nextEip: eip } };
}

function decodeInstruction(
  reader: IsaDecodeReader,
  eip: number
):
  | Readonly<{ kind: "instruction"; instruction: IsaDecodedInstruction }>
  | Extract<IsaBlockTerminator, { kind: "unsupported" | "decode-fault" }> {
  try {
    const decoded = decodeIsaInstructionFromReader(reader, eip);

    if (decoded.kind === "unsupported") {
      return {
        kind: "unsupported",
        address: decoded.address,
        length: decoded.length,
        raw: decoded.raw,
        ...(decoded.unsupportedByte === undefined ? {} : { unsupportedByte: decoded.unsupportedByte })
      };
    }

    return { kind: "instruction", instruction: decoded.instruction };
  } catch (error: unknown) {
    if (error instanceof IsaDecodeError && error.fault.reason === "instructionTooLong") {
      return {
        kind: "decode-fault",
        fault: error.fault
      };
    }

    if (error instanceof IsaDecodeError || error instanceof RangeError) {
      return {
        kind: "decode-fault",
        fault: truncatedInstructionFault(eip, readAvailableBytes(reader, eip, X86_32_CORE.instructionLengthLimit))
      };
    }

    throw error;
  }
}

function shouldEndDecodedBlock(instruction: IsaDecodedInstruction): boolean {
  switch (instruction.spec.mnemonic) {
    case "call":
    case "int":
    case "int3":
    case "jmp":
    case "ret":
      return true;
    default:
      return false;
  }
}
