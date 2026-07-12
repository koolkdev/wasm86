import { encodeU32Leb128 } from "./leb128.js";

export type WasmMemoryLimits = Readonly<{
  minPages: number;
  maxPages?: number;
}>;

export type WasmMemoryImmediate = Readonly<{
  align: number;
  offset: number;
  memoryIndex: number;
}>;

const indexedMemoryFlag = 0x40;

export function encodeMemoryImmediate(immediate: WasmMemoryImmediate): number[] {
  validateU32(immediate.align, "memory alignment");
  validateU32(immediate.offset, "memory offset");
  validateU32(immediate.memoryIndex, "memory index");

  if (immediate.align >= indexedMemoryFlag) {
    throw new RangeError(`memory alignment must be below ${indexedMemoryFlag}: ${immediate.align}`);
  }

  if (immediate.memoryIndex === 0) {
    return [...encodeU32Leb128(immediate.align), ...encodeU32Leb128(immediate.offset)];
  }

  return [
    ...encodeU32Leb128(immediate.align | indexedMemoryFlag),
    ...encodeU32Leb128(immediate.memoryIndex),
    ...encodeU32Leb128(immediate.offset)
  ];
}

export function validateMemoryLimits(limits: WasmMemoryLimits): void {
  validateU32(limits.minPages, "memory minimum pages");

  if (limits.maxPages !== undefined) {
    validateU32(limits.maxPages, "memory maximum pages");

    if (limits.maxPages < limits.minPages) {
      throw new RangeError("memory maximum pages must be greater than or equal to minimum pages");
    }
  }
}

function validateU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
}
