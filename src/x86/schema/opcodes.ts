import type { FixedHighBits, OpcodePath, OpcodePathPart } from "./types.js";

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

export function opcodePathMatches(path: OpcodePath, bytes: readonly number[]): boolean {
  validateOpcodePath(path);

  if (bytes.length < path.length) {
    return false;
  }

  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    const byte = bytes[index];

    if (part === undefined || byte === undefined || !opcodePartMatches(part, byte)) {
      return false;
    }
  }

  return true;
}

export function opcodePartMatches(part: OpcodePathPart, byteRead: number): boolean {
  validateByte(byteRead, "opcode byte read");

  if (typeof part === "number") {
    validateByte(part, "opcode byte");
    return byteRead === part;
  }

  validateOpcodePathPart(part);

  const bits = part.bits ?? 8;
  return byteRead >>> (8 - bits) === part.byte >>> (8 - bits);
}

export function variableOpcodePartCount(path: OpcodePath): number {
  return path.filter((part) => typeof part !== "number" && (part.bits ?? 8) < 8).length;
}

export function opcodeLowBits(path: OpcodePath, bytes: readonly number[]): number | undefined {
  if (!opcodePathMatches(path, bytes)) {
    return undefined;
  }

  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    const byte = bytes[index];

    if (part !== undefined && byte !== undefined && typeof part !== "number" && (part.bits ?? 8) < 8) {
      return byte & lowMask(part.bits ?? 8);
    }
  }

  return undefined;
}

export function expandOpcodePath(path: OpcodePath): readonly (readonly number[])[] {
  validateOpcodePath(path);

  const expanded: number[][] = [[]];

  for (const part of path) {
    const values = expandOpcodePart(part);
    const next: number[][] = [];

    for (const prefix of expanded) {
      for (const value of values) {
        next.push([...prefix, value]);
      }
    }

    expanded.splice(0, expanded.length, ...next);
  }

  return expanded;
}

function expandOpcodePart(part: OpcodePathPart): readonly number[] {
  if (typeof part === "number") {
    validateByte(part, "opcode byte");
    return [part];
  }

  validateOpcodePathPart(part);

  const bits = part.bits ?? 8;
  const count = 1 << (8 - bits);
  const values: number[] = [];

  for (let low = 0; low < count; low += 1) {
    values.push(part.byte | low);
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
