export type GuestMemoryAccess = "read" | "write";

export type MemoryFault = Readonly<{
  faultAddress: number;
  faultSize: number;
  guestAccess: GuestMemoryAccess;
}>;

export type MemoryReadResult = Readonly<{ ok: true; value: number }> | Readonly<{ ok: false; fault: MemoryFault }>;
export type MemoryWriteResult = Readonly<{ ok: true }> | Readonly<{ ok: false; fault: MemoryFault }>;

export type GuestMemory = Readonly<{
  byteLength: number;
  checkAccess(address: number, byteLength: number, operation: GuestMemoryAccess): MemoryFault | undefined;
  readU8(address: number): MemoryReadResult;
  readU16(address: number): MemoryReadResult;
  readU32(address: number): MemoryReadResult;
  writeU8(address: number, value: number): MemoryWriteResult;
  writeU16(address: number, value: number): MemoryWriteResult;
  writeU32(address: number, value: number): MemoryWriteResult;
}>;

const maxU32Address = 0xffff_ffff;

export class ArrayBufferGuestMemory implements GuestMemory {
  readonly #view: DataView<ArrayBuffer>;

  constructor(byteLengthOrBuffer: number | ArrayBuffer) {
    const buffer = typeof byteLengthOrBuffer === "number" ? new ArrayBuffer(byteLengthOrBuffer) : byteLengthOrBuffer;

    this.#view = new DataView(buffer);
  }

  get byteLength(): number {
    return this.#view.byteLength;
  }

  checkAccess(address: number, byteLength: number, operation: GuestMemoryAccess): MemoryFault | undefined {
    return this.#fault(address, byteLength, operation);
  }

  readU8(address: number): MemoryReadResult {
    const fault = this.#fault(address, 1, "read");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    return { ok: true, value: this.#view.getUint8(address) };
  }

  readU16(address: number): MemoryReadResult {
    const fault = this.#fault(address, 2, "read");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    return { ok: true, value: this.#view.getUint16(address, true) };
  }

  readU32(address: number): MemoryReadResult {
    const fault = this.#fault(address, 4, "read");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    return { ok: true, value: this.#view.getUint32(address, true) };
  }

  writeU8(address: number, value: number): MemoryWriteResult {
    const fault = this.#fault(address, 1, "write");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    this.#view.setUint8(address, value & 0xff);
    return { ok: true };
  }

  writeU16(address: number, value: number): MemoryWriteResult {
    const fault = this.#fault(address, 2, "write");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    this.#view.setUint16(address, value & 0xffff, true);
    return { ok: true };
  }

  writeU32(address: number, value: number): MemoryWriteResult {
    const fault = this.#fault(address, 4, "write");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    this.#view.setUint32(address, value >>> 0, true);
    return { ok: true };
  }

  #fault(address: number, size: number, operation: GuestMemoryAccess): MemoryFault | undefined {
    return isInBounds(address, size, this.byteLength)
      ? undefined
      : { faultAddress: address, faultSize: size, guestAccess: operation };
  }
}

function isInBounds(address: number, size: number, byteLength: number): boolean {
  return (
    Number.isInteger(address) &&
    address >= 0 &&
    address <= maxU32Address &&
    size >= 0 &&
    address <= byteLength - size
  );
}
