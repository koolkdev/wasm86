import { u32 } from "#x86/numeric.js";

export const CompletionExit = {
  INSTRUCTION_LIMIT: 0,
  // A runtime-computed jump target; the host resumes at the flushed eip.
  DYNAMIC_JUMP: 1,
  // An unpatched link stub; the payload is the uncompiled target eip.
  LINK_STUB: 2
} as const;

export type CompletionExit = (typeof CompletionExit)[keyof typeof CompletionExit];

export const HostExit = {
  TRAP: 0,
  UNSUPPORTED: 1,
  DECODE_FAULT: 2,
  MEMORY_READ_FAULT: 3,
  MEMORY_WRITE_FAULT: 4
} as const;

export type HostExit = (typeof HostExit)[keyof typeof HostExit];

export type DecodedExit =
  | DecodedCompletionExit
  | DecodedHostExit;

export type DecodedCompletionExit = Readonly<{
  family: "completion";
  reason: CompletionExit;
  payload: number;
}>;

export type DecodedHostExit = Readonly<{
  family: "host";
  reason: HostExit;
  payload: number;
  detail?: number;
}>;

const payloadMask = 0xffff_ffffn;
const codeMask = 0xffffn;
const subtypeMask = 0xffn;
const codeShift = 32n;
const familyShift = 8;
const detailMask = 0xffffn;
const detailShift = 48n;
const completionFamily = 0x01;
const hostFamily = 0x02;
const families = new Set<number>([
  completionFamily,
  hostFamily
]);
const completionExits = new Set<number>(Object.values(CompletionExit));
const hostExits = new Set<number>(Object.values(HostExit));

export function encodeCompletionExit(reason: CompletionExit, payload: number): bigint {
  assertCompletionExit(reason);

  return encodeExitCode(completionFamily, reason, payload);
}

export function encodeHostExit(reason: HostExit, payload: number, detail = 0): bigint {
  assertHostExit(reason);

  return encodeExitCode(hostFamily, reason, payload, detail);
}

function encodeExitCode(family: number, subtype: number, payload: number, detail = 0): bigint {
  assertFamily(family);
  assertSubtype(subtype);
  assertExitDetail(detail);

  const code = (family << familyShift) | subtype;

  return BigInt.asIntN(64, (BigInt(detail) << detailShift) | (BigInt(code) << codeShift) | BigInt(u32(payload)));
}

export function decodeExit(value: bigint): DecodedExit {
  const code = Number((value >> codeShift) & codeMask);
  const family = code >> familyShift;
  const subtype = code & Number(subtypeMask);
  const detail = Number((value >> detailShift) & detailMask);
  const payload = Number(value & payloadMask) >>> 0;

  switch (family) {
    case completionFamily:
      return decodeCompletionExit(subtype, payload, detail);
    case hostFamily:
      return decodeHostExit(subtype, payload, detail);
    default:
      throw new RangeError(`unknown Wasm exit family: ${family}`);
  }
}

function decodeCompletionExit(subtype: number, payload: number, detail: number): DecodedCompletionExit {
  assertCompletionExit(subtype);
  assertNoCompletionDetail(detail);

  return {
    family: "completion",
    reason: subtype,
    payload
  };
}

function assertNoCompletionDetail(value: number): void {
  if (value !== 0) {
    throw new RangeError(`Wasm completion exit detail must be zero: ${value}`);
  }
}

function decodeHostExit(subtype: number, payload: number, detail: number): DecodedHostExit {
  assertHostExit(subtype);

  const decoded = {
    family: "host",
    reason: subtype,
    payload
  } as const;

  return detail === 0 ? decoded : { ...decoded, detail };
}

function assertFamily(value: number): void {
  if (!Number.isInteger(value) || !families.has(value)) {
    throw new RangeError(`unknown Wasm exit family: ${value}`);
  }
}

function assertSubtype(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > Number(subtypeMask)) {
    throw new RangeError(`Wasm exit subtype out of range: ${value}`);
  }
}

function assertCompletionExit(value: number): asserts value is CompletionExit {
  if (!Number.isInteger(value) || !completionExits.has(value)) {
    throw new RangeError(`unknown Wasm completion exit: ${value}`);
  }
}

function assertHostExit(value: number): asserts value is HostExit {
  if (!Number.isInteger(value) || !hostExits.has(value)) {
    throw new RangeError(`unknown Wasm host exit: ${value}`);
  }
}

function assertExitDetail(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > Number(detailMask)) {
    throw new RangeError(`Wasm exit detail out of range: ${value}`);
  }
}
