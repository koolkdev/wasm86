import { decodeIsaInstructionFromReader } from "#core/decoder/decode.js";
import type {
  IsaDecodedInstruction,
  IsaDecodeExceptionResult,
  IsaDecodeReader
} from "#core/decoder/types.js";
import { u32 } from "#core/numeric.js";
import { guestMemoryAccess } from "#memory/access.js";

export type JitDecodedBlock = Readonly<{
  startEip: number;
  instructions: readonly IsaDecodedInstruction[];
  terminator: JitBlockTerminator;
}>;

export type JitBlockTerminator =
  | Readonly<{ kind: "fallthrough"; nextEip: number }>
  | Readonly<{ kind: "control"; instruction: IsaDecodedInstruction }>
  | IsaDecodeExceptionResult;

export type DecodeJitBlockOptions = Readonly<{
  maxInstructions?: number;
}>;

const defaultMaxInstructions = 64;

export function decodeJitBlock(
  memory: WebAssembly.Memory,
  startEip: number,
  options: DecodeJitBlockOptions = {}
): JitDecodedBlock {
  const instructions: IsaDecodedInstruction[] = [];
  const maxInstructions = options.maxInstructions ?? defaultMaxInstructions;
  const memoryAccess = guestMemoryAccess.bindHost(memory);
  const reader: IsaDecodeReader = {
    readU8(address) {
      const resolved = memoryAccess.resolveByte(address, "instructionFetch");

      if (resolved.kind === "access") {
        return {
          kind: "byte",
          value: memoryAccess.readByte(resolved.access)
        };
      }

      return {
        kind: "cpuException",
        exception: resolved.exception
      };
    }
  };
  let eip = u32(startEip);

  for (let count = 0; count < maxInstructions; count += 1) {
    const decoded = decodeIsaInstructionFromReader(reader, eip);

    if (decoded.kind === "cpuException") {
      return { startEip, instructions, terminator: decoded };
    }

    instructions.push(decoded.instruction);

    if (shouldEndDecodedBlock(decoded.instruction)) {
      return {
        startEip,
        instructions,
        terminator: { kind: "control", instruction: decoded.instruction }
      };
    }

    eip = decoded.instruction.nextEip;
  }

  return {
    startEip,
    instructions,
    terminator: { kind: "fallthrough", nextEip: eip }
  };
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
