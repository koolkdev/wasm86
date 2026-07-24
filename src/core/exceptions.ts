export type PageFault<T> = Readonly<{
  kind: "PF";
  linearAddress: T;
  errorCode: T;
}>;

export type CpuException<T> =
  | Readonly<{ kind: "DE" }>
  | Readonly<{ kind: "UD" }>
  | Readonly<{ kind: "GP"; errorCode: T }>
  | PageFault<T>;

export const CpuExceptionVector = {
  DE: 0,
  UD: 6,
  GP: 13,
  PF: 14
} as const;

export type CpuExceptionVector = (typeof CpuExceptionVector)[keyof typeof CpuExceptionVector];

export const PageFaultErrorCode = {
  PRESENT: 1 << 0,
  WRITE: 1 << 1,
  INSTRUCTION_FETCH: 1 << 4
} as const;

export type PageFaultAccess =
  | "read"
  | "write"
  | "instructionFetch";

export function divideError<T = never>(): CpuException<T> {
  return { kind: "DE" };
}

export function invalidOpcode<T = never>(): CpuException<T> {
  return { kind: "UD" };
}

export function generalProtection<T>(errorCode: T): CpuException<T> {
  return { kind: "GP", errorCode };
}

export function pageFault<T>(linearAddress: T, errorCode: T): PageFault<T> {
  return { kind: "PF", linearAddress, errorCode };
}

export function mapCpuException<TSource, TTarget>(
  exception: CpuException<TSource>,
  mapValue: (value: TSource) => TTarget
): CpuException<TTarget> {
  switch (exception.kind) {
    case "DE":
    case "UD":
      return exception;
    case "GP":
      return generalProtection(mapValue(exception.errorCode));
    case "PF":
      return pageFault(
        mapValue(exception.linearAddress),
        mapValue(exception.errorCode)
      );
  }
}

export function pageFaultErrorCode(access: PageFaultAccess): number {
  switch (access) {
    case "read":
      return 0;
    case "write":
      return PageFaultErrorCode.WRITE;
    case "instructionFetch":
      return PageFaultErrorCode.INSTRUCTION_FETCH;
  }
}
