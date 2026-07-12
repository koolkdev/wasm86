export function signedImm8(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`imm8 value out of range: ${value}`);
  }

  return value & 0x80 ? value - 0x100 : value;
}

export function signedImm32(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`imm32 value out of range: ${value}`);
  }

  return value | 0;
}
