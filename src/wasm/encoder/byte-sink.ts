import { encodeU32Leb128 } from "./leb128.js";

export class ByteSink {
  readonly #bytes: number[] = [];

  get byteLength(): number {
    return this.#bytes.length;
  }

  writeByte(byte: number): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new RangeError(`Wasm byte out of range: ${byte}`);
    }

    this.#bytes.push(byte);
  }

  writeBytes(bytes: readonly number[] | Uint8Array<ArrayBufferLike>): void {
    for (const byte of bytes) {
      this.writeByte(byte);
    }
  }

  writeU32(value: number): void {
    this.writeBytes(encodeU32Leb128(value));
  }

  writeVecLength(length: number): void {
    this.writeU32(length);
  }

  writeName(name: string): void {
    if (name.length === 0) {
      throw new Error("Wasm name must not be empty");
    }

    const bytes = new TextEncoder().encode(name);
    this.writeU32(bytes.length);
    this.writeBytes(bytes);
  }

  writeSection(id: number, writeContent: (section: ByteSink) => void): void {
    const content = new ByteSink();
    writeContent(content);

    this.writeByte(id);
    this.writeU32(content.byteLength);
    this.writeBytes(content.toBytes());
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#bytes);
  }
}
