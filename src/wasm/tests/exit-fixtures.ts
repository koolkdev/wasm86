import { ok } from "node:assert";

import { PageFaultErrorCode, divideError, pageFault } from "#x86/exceptions.js";
import type { CpuException } from "#x86/exceptions.js";
import type { DecodedCpuExceptionExit } from "#wasm/exit.js";

export type PageFaultException = Extract<CpuException<number>, { kind: "PF" }>;

export function assertPageFaultException(
  exception: CpuException<number>,
  label = "expected page fault exception"
): asserts exception is PageFaultException {
  ok(exception.kind === "PF", label);
}

export function divideErrorExit(): DecodedCpuExceptionExit {
  return {
    family: "cpuException",
    exception: divideError()
  };
}

export function readPageFaultExit(linearAddress: number): DecodedCpuExceptionExit {
  return pageFaultExit(linearAddress, 0);
}

export function writePageFaultExit(linearAddress: number): DecodedCpuExceptionExit {
  return pageFaultExit(linearAddress, PageFaultErrorCode.WRITE);
}

export function fetchPageFaultExit(linearAddress: number): DecodedCpuExceptionExit {
  return pageFaultExit(linearAddress, PageFaultErrorCode.INSTRUCTION_FETCH);
}

function pageFaultExit(linearAddress: number, errorCode: number): DecodedCpuExceptionExit {
  return {
    family: "cpuException",
    exception: pageFault(linearAddress, errorCode)
  };
}
