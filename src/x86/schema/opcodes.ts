import type { FixedHighBits, OpcodePath, OpcodePathPart } from "./types.js";

export type ExpandedOpcode = Readonly<{
  bytes: readonly number[];
  lowBits?: number;
}>;

type ExpandedOpcodePart = Readonly<{
  byte: number;
  lowBits?: number;
}>;

export function opcodePlusReg(byte: number): Readonly<{ byte: number; bits: 5 }> {
  return { byte, bits: 5 };
}

export function validateOpcodePath(path: OpcodePath): void {
  if (path.length === 0) {
    throw new Error("opcode path must not be empty");
  }

  for (const part of path) {
    validateOpcodePathPart(part);
  }
}

export function validateOpcodePathPart(part: OpcodePathPart): void {
  if (typeof part === "number") {
    validateByte(part, "opcode byte");
    return;
  }

  validateByte(part.byte, "opcode byte");

  const bits = part.bits ?? 8;
  validateFixedHighBits(bits);

  if (bits < 8 && lowMask(bits) !== 0 && (part.byte & lowMask(bits)) !== 0) {
    throw new Error("variable opcode low bits must be zero in descriptor byte");
  }
}

export function variableOpcodePartCount(path: OpcodePath): number {
  return path.filter((part) => typeof part !== "number" && (part.bits ?? 8) < 8).length;
}

export function expandOpcodePath(path: OpcodePath): readonly ExpandedOpcode[] {
  validateOpcodePath(path);

  const expanded: ExpandedOpcode[] = [{ bytes: [] }];

  for (const part of path) {
    const values = expandOpcodePart(part);
    const next: ExpandedOpcode[] = [];

    for (const prefix of expanded) {
      for (const value of values) {
        const bytes = [...prefix.bytes, value.byte];
        const lowBits = prefix.lowBits ?? value.lowBits;

        next.push(lowBits === undefined ? { bytes } : { bytes, lowBits });
      }
    }

    expanded.splice(0, expanded.length, ...next);
  }

  return expanded;
}

function expandOpcodePart(part: OpcodePathPart): readonly ExpandedOpcodePart[] {
  if (typeof part === "number") {
    validateByte(part, "opcode byte");
    return [{ byte: part }];
  }

  validateOpcodePathPart(part);

  const bits = part.bits ?? 8;
  const count = 1 << (8 - bits);
  const values: ExpandedOpcodePart[] = [];

  for (let low = 0; low < count; low += 1) {
    const byte = part.byte | low;
    values.push(bits < 8 ? { byte, lowBits: low } : { byte });
  }

  return values;
}

function validateByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${label} must be an integer in 0..255`);
  }
}

function validateFixedHighBits(bits: number): asserts bits is FixedHighBits {
  if (!Number.isInteger(bits) || bits < 1 || bits > 8) {
    throw new Error("opcode fixed high bits must be an integer in 1..8");
  }
}

function lowMask(bits: FixedHighBits): number {
  return (1 << (8 - bits)) - 1;
}
