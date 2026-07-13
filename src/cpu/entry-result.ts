import { assert } from "#common/assert.js";
import { segmentRegisters } from "#core/types.js";
import {
  CompletionExit,
  decodeExit,
  HostExit,
  type DecodedHostExit
} from "#wasm/exit.js";
import type { RunStop } from "./cpu.js";

export function decodeEntryResult(encodedResult: bigint): RunStop {
  const result = decodeExit(encodedResult);

  switch (result.family) {
    case "completion":
      assert(
        result.reason === CompletionExit.INSTRUCTION_LIMIT,
        `interpreter entry returned a nonterminal completion: ${result.reason}`
      );
      assert(
        result.payload === 0,
        `instruction-limit entry result payload must be zero: ${result.payload}`
      );
      return { kind: "instructionLimit" };
    case "host":
      return stopFromHostExit(result);
    case "cpuException":
      return {
        kind: "cpuException",
        exception: result.exception
      };
  }
}

function stopFromHostExit(exit: DecodedHostExit): RunStop {
  switch (exit.reason) {
    case HostExit.TRAP:
      assert(
        exit.payload <= 0xff,
        `host-trap entry result vector must be an x86 interrupt vector: ${exit.payload}`
      );
      return { kind: "hostTrap", vector: exit.payload };
    case HostExit.UNSUPPORTED:
      assert(
        exit.payload === 0,
        `unsupported entry result payload must be zero: ${exit.payload}`
      );
      return { kind: "unsupported", reason: "unsupportedOpcode" };
    case HostExit.SEGMENT_LOAD: {
      const segmentIndex = exit.payload >>> 16;
      const segment = segmentRegisters[segmentIndex];

      assert(
        segment !== undefined,
        `segment-load entry result has invalid segment index: ${segmentIndex}`
      );
      return {
        kind: "segmentLoad",
        segment,
        selector: exit.payload & 0xffff
      };
    }
  }
}
