import { assert } from "#common/assert.js";
import { u32 } from "#x86/numeric.js";
import {
  CpuExceptionVector,
  divideError,
  pageFault,
  type CpuException
} from "#x86/exceptions.js";

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
  UNSUPPORTED: 1
} as const;

export type HostExit = (typeof HostExit)[keyof typeof HostExit];

export type DecodedExit =
  | DecodedCompletionExit
  | DecodedHostExit
  | DecodedCpuExceptionExit;

export type DecodedCompletionExit = Readonly<{
  family: "completion";
  reason: CompletionExit;
  payload: number;
}>;

export type DecodedHostExit = Readonly<{
  family: "host";
  reason: HostExit;
  payload: number;
}>;

export type DecodedCpuExceptionExit = Readonly<{
  family: "cpuException";
  exception: CpuException<number>;
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
const cpuExceptionFamily = 0x03;
const families = new Set<number>([
  completionFamily,
  hostFamily,
  cpuExceptionFamily
]);
const completionExits = new Set<number>(Object.values(CompletionExit));
const hostExits = new Set<number>(Object.values(HostExit));

export function encodeCompletionExit(reason: CompletionExit, payload: number): bigint {
  assertCompletionExit(reason);

  return encodeExitCode(completionFamily, reason, payload);
}

export function encodeHostExit(reason: HostExit, payload: number): bigint {
  assertHostExit(reason);

  return encodeExitCode(hostFamily, reason, payload);
}

export function encodeCpuExceptionExit(exception: CpuException<number>): bigint {
  switch (exception.kind) {
    case "DE":
      return encodeExitCode(cpuExceptionFamily, CpuExceptionVector.DE, 0, 0);
    case "PF":
      return encodeExitCode(
        cpuExceptionFamily,
        CpuExceptionVector.PF,
        exception.linearAddress,
        exception.errorCode
      );
  }
}

export function encodeCpuExceptionExitBase(vector: number, detail: number): bigint {
  assertCpuExceptionVector(vector);
  assertCpuExceptionExitFields(vector, 0, detail);

  return encodeExitCode(cpuExceptionFamily, vector, 0, detail);
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
    case cpuExceptionFamily:
      return decodeCpuExceptionExit(subtype, payload, detail);
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
  assertNoHostDetail(detail);

  return {
    family: "host",
    reason: subtype,
    payload
  };
}

function assertNoHostDetail(value: number): void {
  if (value !== 0) {
    throw new RangeError(`Wasm host exit detail must be zero: ${value}`);
  }
}

function decodeCpuExceptionExit(subtype: number, payload: number, detail: number): DecodedCpuExceptionExit {
  assertCpuExceptionVector(subtype);
  assertCpuExceptionExitFields(subtype, payload, detail);

  switch (subtype) {
    case CpuExceptionVector.DE:
      return {
        family: "cpuException",
        exception: divideError()
      };
    case CpuExceptionVector.PF:
      return {
        family: "cpuException",
        exception: pageFault(payload, detail)
      };
  }
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

function assertCpuExceptionVector(value: number): asserts value is CpuExceptionVector {
  switch (value) {
    case CpuExceptionVector.DE:
    case CpuExceptionVector.PF:
      return;
    default:
      throw new RangeError(`unknown x86 CPU exception vector: ${value}`);
  }
}

function assertCpuExceptionExitFields(vector: CpuExceptionVector, payload: number, detail: number): void {
  switch (vector) {
    case CpuExceptionVector.DE:
      assert(payload === 0, `Wasm CPU exception exit payload must be zero: ${payload}`);
      assert(detail === 0, `Wasm CPU exception exit detail must be zero: ${detail}`);
      return;
    case CpuExceptionVector.PF:
      return;
  }
}

function assertExitDetail(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > Number(detailMask)) {
    throw new RangeError(`Wasm exit detail out of range: ${value}`);
  }
}
