export function readBackingByte(memory: WebAssembly.Memory, address: number): number | undefined {
  if (!Number.isInteger(address) || address < 0) {
    return undefined;
  }

  return new Uint8Array(memory.buffer)[address];
}

export function writeBackingBytes(
  memory: WebAssembly.Memory,
  address: number,
  bytes: ArrayLike<number>
): number | undefined {
  for (let index = 0; index < bytes.length; index += 1) {
    const targetAddress = address + index;
    const view = new Uint8Array(memory.buffer);

    if (!Number.isInteger(targetAddress) || targetAddress < 0 || targetAddress >= view.length) {
      return targetAddress;
    }

    view[targetAddress] = bytes[index] ?? 0;
  }

  return undefined;
}
