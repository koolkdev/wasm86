import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  defaultSegmentForBase,
  type EffectiveAddress,
  type MemOperand,
  type OperandWidth,
  type Reg32,
  type RegName
} from "#x86/types.js";
import { registerAlias } from "#x86/registers.js";
import {
  decodeFault,
  IsaDecodeError,
  type IsaDecodeReader
} from "#x86/decoder/reader.js";
import type { IsaDecodedInstruction, IsaDecodeResult } from "#x86/decoder/types.js";
import type { IsaOperandBinding } from "#x86/decoder/types.js";
import { decodeIsaInstructionFromReader } from "#x86/decoder/decode.js";

export const startAddress = 0x1000;

export function bytes(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(values);
}

export function ok(result: IsaDecodeResult): IsaDecodedInstruction {
  if (result.kind !== "ok") {
    throw new Error(`expected ISA decode success, got unsupported byte ${result.unsupportedByte}`);
  }

  return result.instruction;
}

export function decodeBytes(values: readonly number[], address = startAddress): IsaDecodeResult {
  return decodeIsaInstructionFromReader(new ByteArrayDecodeReader(values, address), address);
}

export class ByteArrayDecodeReader implements IsaDecodeReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(values: readonly number[] | Uint8Array<ArrayBuffer>, readonly baseAddress = 0) {
    this.#bytes = values instanceof Uint8Array ? values : Uint8Array.from(values);
  }

  readU8(eip: number): number {
    const index = eip - this.baseAddress;

    if (!Number.isInteger(index) || index < 0 || index >= this.#bytes.length) {
      throw new IsaDecodeError(decodeFault(eip));
    }

    const value = this.#bytes[index];

    if (value === undefined) {
      throw new IsaDecodeError(decodeFault(eip));
    }

    return value;
  }
}

export type DecoderFixture = Readonly<{
  name: string;
  bytes: readonly number[];
  mnemonic: string;
  operands?: readonly IsaOperandBinding[];
  address?: number;
  id?: string;
  format?: string;
}>;

export function testDecodeFixtures(fixtures: readonly DecoderFixture[]): void {
  for (const fixture of fixtures) {
    test(`decodes ${fixture.name}`, () => {
      const address = fixture.address ?? startAddress;
      const decoded = decodeBytes(fixture.bytes, address);

      strictEqual(decoded.kind, "ok");
      if (decoded.kind !== "ok") {
        return;
      }

      strictEqual(decoded.instruction.address, address);
      strictEqual(decoded.instruction.length, fixture.bytes.length);
      strictEqual(decoded.instruction.spec.mnemonic, fixture.mnemonic);
      strictEqual(decoded.instruction.nextEip, address + fixture.bytes.length);
      deepStrictEqual(decoded.instruction.raw, fixture.bytes);
      deepStrictEqual(decoded.instruction.operands, fixture.operands ?? []);

      if (fixture.id !== undefined) {
        strictEqual(decoded.instruction.spec.id, fixture.id);
      }

      if (fixture.format !== undefined) {
        strictEqual(decoded.instruction.spec.format.syntax, fixture.format);
      }
    });
  }
}

export function reg32(regName: Reg32): IsaOperandBinding {
  return reg(regName);
}

export function reg(regName: RegName): IsaOperandBinding {
  return { kind: "reg", alias: registerAlias(regName) };
}

export function mem(
  width: OperandWidth,
  operand: Readonly<{
    segment?: EffectiveAddress["segment"];
    base?: EffectiveAddress["base"];
    index?: EffectiveAddress["index"];
    scale: EffectiveAddress["scale"];
    disp: number;
  }>
): MemOperand {
  return {
    kind: "mem",
    accessWidth: width,
    segment: operand.segment ?? defaultSegmentForBase(operand.base),
    base: operand.base,
    index: operand.index,
    scale: operand.scale,
    disp: operand.disp
  };
}

export function mem32(operand: Parameters<typeof mem>[1]): MemOperand {
  return mem(32, operand);
}

export function imm32(value: number): IsaOperandBinding {
  return { kind: "imm", value, encodedWidth: 32, semanticWidth: 32 };
}

export function imm16(value: number): IsaOperandBinding {
  return { kind: "imm", value, encodedWidth: 16, semanticWidth: 16 };
}

export function imm8(value: number): IsaOperandBinding {
  return { kind: "imm", value, encodedWidth: 8, semanticWidth: 8 };
}

export function signImm8(value: number): IsaOperandBinding {
  return { kind: "imm", value: value >>> 0, encodedWidth: 8, semanticWidth: 32, extension: "sign" };
}

export function relTarget(width: 8 | 16 | 32, displacement: number, target: number): IsaOperandBinding {
  return { kind: "relTarget", width, displacement, target };
}
