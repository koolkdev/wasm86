import type { OpcodePath, OpcodePathPart } from "./types.js";

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

export function expandOpcodePath(path: OpcodePath): readonly ExpandedOpcode[] {
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
    return [{ byte: part }];
  }

  const bits = part.bits ?? 8;
  const count = 1 << (8 - bits);
  const values: ExpandedOpcodePart[] = [];

  for (let low = 0; low < count; low += 1) {
    const byte = part.byte | low;
    values.push(bits < 8 ? { byte, lowBits: low } : { byte });
  }

  return values;
}
