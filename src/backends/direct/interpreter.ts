import { runResultFromState, StopReason, type RunResult } from "#x86/execution/run-result.js";
import type { GuestMemory } from "#x86/memory/guest-memory.js";
import type { CpuState } from "#x86/state/cpu-state.js";
import { decodeIsaInstructionFromReader } from "#x86/decoder/decode.js";
import {
  IsaDecodeError,
  maxX86InstructionLength,
  readAvailableBytes
} from "#x86/decoder/reader.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { GuestMemoryDecodeReader, type RegionedDecodeReader } from "#x86/decoder/guest-memory-reader.js";
import { executeDirectInstruction } from "./execute.js";

const defaultInstructionLimit = 10_000;

export type DirectInterpreterOptions = Readonly<{
  instructionLimit?: number;
}>;

export function runDirectInterpreter(
  state: CpuState,
  memory: GuestMemory,
  options: DirectInterpreterOptions = {}
): RunResult {
  const decodeReader = new GuestMemoryDecodeReader(memory, [
    { kind: "guest-memory", baseAddress: 0, byteLength: memory.byteLength }
  ]);
  const instructionLimit = options.instructionLimit ?? defaultInstructionLimit;

  for (let executed = 0; executed < instructionLimit; executed += 1) {
    const decoded = decodeInstruction(state, decodeReader);

    if (decoded.kind === "stop") {
      if (isTrailingDecodeFault(decoded.result, executed)) {
        state.stopReason = StopReason.NONE;
        return runResultFromState(state, StopReason.NONE);
      }

      return decoded.result;
    }

    const result = executeDirectInstruction(state, decoded.instruction, { memory });

    if (result.stopReason !== StopReason.NONE) {
      return result;
    }
  }

  state.stopReason = StopReason.INSTRUCTION_LIMIT;
  return runResultFromState(state, StopReason.INSTRUCTION_LIMIT);
}

type DecodeInstructionResult =
  | Readonly<{ kind: "instruction"; instruction: IsaDecodedInstruction }>
  | Readonly<{ kind: "stop"; result: RunResult }>;

function decodeInstruction(
  state: CpuState,
  decodeReader: RegionedDecodeReader
): DecodeInstructionResult {
  try {
    const decoded = decodeIsaInstructionFromReader(decodeReader, state.eip);

    if (decoded.kind === "unsupported") {
      state.stopReason = StopReason.UNSUPPORTED;
      return {
        kind: "stop",
        result: runResultFromState(
          state,
          StopReason.UNSUPPORTED,
          decoded.unsupportedByte === undefined
            ? { unsupportedReason: "unsupportedOpcode" }
            : { unsupportedByte: decoded.unsupportedByte, unsupportedReason: "unsupportedOpcode" }
        )
      };
    }

    return { kind: "instruction", instruction: decoded.instruction };
  } catch (error: unknown) {
    if (error instanceof IsaDecodeError || error instanceof RangeError) {
      const raw = readAvailableBytes(decodeReader, state.eip, maxX86InstructionLength);

      state.stopReason = StopReason.DECODE_FAULT;
      return {
        kind: "stop",
        result: runResultFromState(state, StopReason.DECODE_FAULT, {
          faultAddress: state.eip,
          faultSize: raw.length,
          faultOperation: "execute"
        })
      };
    }

    throw error;
  }
}

function isTrailingDecodeFault(result: RunResult, executed: number): boolean {
  return executed > 0 && result.stopReason === StopReason.DECODE_FAULT && result.faultSize === 0;
}
