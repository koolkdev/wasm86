import type { FaultOperation } from "#x86/execution/run-result.js";
import type {
  GuestMemory,
  MemoryFault,
  MemoryReadResult,
  MemoryWriteResult
} from "#x86/memory/guest-memory.js";

const maxU32Address = 0xffff_ffff;

export class WasmGuestMemory implements GuestMemory {
  constructor(readonly memory: WebAssembly.Memory) {}

  get byteLength(): number {
    return this.memory.buffer.byteLength;
  }

  checkAccess(address: number, byteLength: number, operation: FaultOperation): MemoryFault | undefined {
    return this.#fault(address, byteLength, operation);
  }

  readU8(address: number): MemoryReadResult {
    const fault = this.#fault(address, 1, "read");

    return fault === undefined
      ? { ok: true, value: this.#view().getUint8(address) }
      : { ok: false, fault };
  }

  readU16(address: number): MemoryReadResult {
    const fault = this.#fault(address, 2, "read");

    return fault === undefined
      ? { ok: true, value: this.#view().getUint16(address, true) }
      : { ok: false, fault };
  }

  readU32(address: number): MemoryReadResult {
    const fault = this.#fault(address, 4, "read");

    return fault === undefined
      ? { ok: true, value: this.#view().getUint32(address, true) }
      : { ok: false, fault };
  }

  writeU8(address: number, value: number): MemoryWriteResult {
    const fault = this.#fault(address, 1, "write");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    this.#view().setUint8(address, value & 0xff);
    return { ok: true };
  }

  writeU16(address: number, value: number): MemoryWriteResult {
    const fault = this.#fault(address, 2, "write");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    this.#view().setUint16(address, value & 0xffff, true);
    return { ok: true };
  }

  writeU32(address: number, value: number): MemoryWriteResult {
    const fault = this.#fault(address, 4, "write");

    if (fault !== undefined) {
      return { ok: false, fault };
    }

    this.#view().setUint32(address, value >>> 0, true);
    return { ok: true };
  }

  #fault(address: number, size: number, operation: FaultOperation): MemoryFault | undefined {
    return isInBounds(address, size, this.byteLength)
      ? undefined
      : { faultAddress: address, faultSize: size, faultOperation: operation };
  }

  #view(): DataView<ArrayBuffer> {
    return new DataView(this.memory.buffer);
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
