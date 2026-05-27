export const maxX86InstructionLength = 15;

export type IsaDecodeFaultReason = "truncated" | "instructionTooLong";

export type IsaDecodeFault = Readonly<{
  reason: IsaDecodeFaultReason;
  address: number;
  offset: number;
  raw: readonly number[];
}>;

export type IsaDecodeReader = Readonly<{
  readU8(eip: number): number;
}>;

export class IsaDecodeError extends Error {
  constructor(readonly fault: IsaDecodeFault) {
    super(`${fault.reason} decode at 0x${fault.address.toString(16)} offset ${fault.offset}`);
    this.name = "IsaDecodeError";
  }
}

export function readU16LE(reader: IsaDecodeReader, eip: number): number {
  const byte0 = reader.readU8(eip);
  const byte1 = reader.readU8(eip + 1);

  return byte0 | (byte1 << 8);
}

export function readU32LE(reader: IsaDecodeReader, eip: number): number {
  const byte0 = reader.readU8(eip);
  const byte1 = reader.readU8(eip + 1);
  const byte2 = reader.readU8(eip + 2);
  const byte3 = reader.readU8(eip + 3);

  return (byte0 | (byte1 << 8) | (byte2 << 16) | (byte3 << 24)) >>> 0;
}

export function readRawBytes(reader: IsaDecodeReader, startEip: number, endEip: number): number[] {
  const raw: number[] = [];

  for (let eip = startEip; eip < endEip; eip += 1) {
    raw.push(reader.readU8(eip));
  }

  return raw;
}

export function readAvailableBytes(reader: IsaDecodeReader, startEip: number, maxBytes: number): number[] {
  const raw: number[] = [];

  for (let offset = 0; offset < maxBytes; offset += 1) {
    try {
      raw.push(reader.readU8(startEip + offset));
    } catch (error: unknown) {
      if (error instanceof IsaDecodeError) {
        return raw;
      }

      throw error;
    }
  }

  return raw;
}

export function decodeFault(address: number, raw: readonly number[] = []): IsaDecodeFault {
  return {
    reason: "truncated",
    address,
    offset: 0,
    raw
  };
}

export function instructionTooLongFault(address: number, raw: readonly number[] = []): IsaDecodeFault {
  return {
    reason: "instructionTooLong",
    address,
    offset: maxX86InstructionLength,
    raw
  };
}
