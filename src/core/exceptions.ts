export type CpuException<T> =
  | Readonly<{ kind: "DE" }>
  | Readonly<{ kind: "UD" }>
  | Readonly<{ kind: "PF"; linearAddress: T; errorCode: T }>;

export const CpuExceptionVector = {
  DE: 0,
  UD: 6,
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

export function divideError<T = never>(): CpuException<T> {
  return { kind: "DE" };
}

export function invalidOpcode<T = never>(): CpuException<T> {
  return { kind: "UD" };
}

export function pageFault<T>(linearAddress: T, errorCode: T): CpuException<T> {
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
