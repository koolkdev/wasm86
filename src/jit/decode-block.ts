import { u32 } from "#common/numeric.js";
import { decodeIsaInstructionFromReader } from "#instructions/decoder/decode.js";
import type {
  IsaDecodedInstruction,
  IsaDecodeExceptionResult,
  IsaDecodeReader
} from "#instructions/decoder/types.js";
import type { InstructionByteSnapshot } from "./instruction-snapshot.js";
import type { JitBlockPolicy } from "./policy.js";

export type JitDecodedBlock = Readonly<{
  startEip: number;
  instructions: readonly IsaDecodedInstruction[];
  terminator: JitBlockTerminator;
}>;

export type JitBlockTerminator =
  | Readonly<{ kind: "fallthrough"; nextEip: number }>
  | Readonly<{ kind: "control"; instruction: IsaDecodedInstruction }>
  | IsaDecodeExceptionResult;

export function decodeJitBlock(
  snapshot: InstructionByteSnapshot,
  policy: JitBlockPolicy
): JitDecodedBlock {
  const startEip = snapshot.linearStart;
  const instructions: IsaDecodedInstruction[] = [];
  const reader: IsaDecodeReader = {
    readU8: (address) => snapshot.readByte(address)
  };
  let eip = u32(startEip);

  for (let count = 0; count < policy.instructionLimit; count += 1) {
    const decoded = decodeIsaInstructionFromReader(reader, eip);

    if (decoded.kind === "cpuException") {
      return {
        startEip,
        instructions,
        terminator: decoded
      };
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
