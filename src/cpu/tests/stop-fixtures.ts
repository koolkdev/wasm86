import { ok } from "node:assert";

import { PageFaultErrorCode, divideError, pageFault } from "#core/exceptions.js";
import type { CpuException } from "#core/exceptions.js";
import type { RunStop } from "#cpu/cpu.js";

export type PageFaultException = Extract<CpuException<number>, { kind: "PF" }>;
export type CpuExceptionStop = Extract<RunStop, { kind: "cpuException" }>;

export function assertPageFaultException(
  exception: CpuException<number>,
  label = "expected page fault exception"
): asserts exception is PageFaultException {
  ok(exception.kind === "PF", label);
}

export function divideErrorStop(): CpuExceptionStop {
  return {
    kind: "cpuException",
    exception: divideError()
  };
}

export function readPageFaultStop(linearAddress: number): CpuExceptionStop {
  return pageFaultStop(linearAddress, 0);
}

export function writePageFaultStop(linearAddress: number): CpuExceptionStop {
  return pageFaultStop(linearAddress, PageFaultErrorCode.WRITE);
}

export function fetchPageFaultStop(linearAddress: number): CpuExceptionStop {
  return pageFaultStop(linearAddress, PageFaultErrorCode.INSTRUCTION_FETCH);
}

function pageFaultStop(linearAddress: number, errorCode: number): CpuExceptionStop {
  return {
    kind: "cpuException",
    exception: pageFault(linearAddress, errorCode)
  };
}
