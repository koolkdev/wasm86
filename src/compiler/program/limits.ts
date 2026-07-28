export type MemoryLimits = Readonly<{
  minPages: number;
  maxPages?: number;
}>;

export type TableLimits = Readonly<{
  minElements: number;
  maxElements?: number;
}>;

export const wasmPageByteLength = 0x1_0000;
export const maximumWasmMemoryPages = 0x1_0000;
export const maximumWasmTableElements = 0xffff_ffff;
export const maximumWasmMemoryByteLength = wasmPageByteLength * maximumWasmMemoryPages;

export function wasmPagesForByteLength(byteLength: number): number {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > maximumWasmMemoryByteLength
  ) {
    throw new RangeError(`Wasm memory byte length out of range: ${byteLength}`);
  }

  return Math.ceil(byteLength / wasmPageByteLength);
}
