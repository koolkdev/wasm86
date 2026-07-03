import { PageFaultErrorCode, pageFault } from "#x86/exceptions.js";
import type { DecodedCpuExceptionExit } from "#wasm/exit.js";

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
