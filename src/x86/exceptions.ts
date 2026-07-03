export type CpuException<T> =
  | Readonly<{ kind: "PF"; linearAddress: T; errorCode: number }>;

export const CpuExceptionVector = {
  PF: 14
} as const;

export type CpuExceptionVector = (typeof CpuExceptionVector)[keyof typeof CpuExceptionVector];

export const PageFaultErrorCode = {
  WRITE: 1 << 1,
  INSTRUCTION_FETCH: 1 << 4
} as const;

export type PageFaultAccess =
  | "dataRead"
  | "dataWrite"
  | "instructionFetch";

export function pageFault<T>(linearAddress: T, errorCode: number): CpuException<T> {
  return { kind: "PF", linearAddress, errorCode };
}

export function pageFaultErrorCode(access: PageFaultAccess): number {
  switch (access) {
    case "dataRead":
      return 0;
    case "dataWrite":
      return PageFaultErrorCode.WRITE;
    case "instructionFetch":
      return PageFaultErrorCode.INSTRUCTION_FETCH;
  }
}
