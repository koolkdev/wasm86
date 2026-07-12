import type { IsaDecodeReader } from "./reader.js";
import { readU32LE } from "./reader.js";
import { signedImm8, signedImm32 } from "./immediate.js";
import { defaultSegmentForBase } from "#core/segments.js";
import {
  reg32,
  type EffectiveAddress,
  type Reg32
} from "#core/types.js";

type Scale = EffectiveAddress["scale"];
type Sib = Readonly<{
  baseField: number;
  index: Reg32 | undefined;
  scale: Scale;
}>;

const modRegister = 0b11;
const sibRmField = 0b100;
const disp32RmField = 0b101;
const noIndexField = 0b100;
const sibScales = [1, 2, 4, 8] as const;

export type ModRmRm =
  | Readonly<{ kind: "reg"; index: number }>
  | Readonly<{ kind: "mem"; address: EffectiveAddress }>;

export type DecodedModRmAddressing = Readonly<{
  mod: number;
  regField: number;
  rmField: number;
  rm: ModRmRm;
  byteLength: number;
}>;

export function rm32ModRmByteLengthAt(reader: IsaDecodeReader, eip: number): number {
  const value = reader.readU8(eip);
  const mod = value >>> 6;
  const rmField = value & 0b111;

  switch (mod) {
    case 0:
      if (rmField === sibRmField) {
        const sibBaseField = reader.readU8(eip + 1) & 0b111;

        return sibBaseField === disp32RmField ? 6 : 2;
      }

      return rmField === disp32RmField ? 5 : 1;
    case 1:
      return rmField === sibRmField ? 3 : 2;
    case 2:
      return rmField === sibRmField ? 6 : 5;
    case modRegister:
      return 1;
    default:
      throw new Error(`ModRM mod field out of range: ${mod}`);
  }
}

export function decodeModRmAddressing(reader: IsaDecodeReader, eip: number): DecodedModRmAddressing {
  const value = reader.readU8(eip);
  const mod = value >>> 6;
  const regField = (value >>> 3) & 0b111;
  const rmField = value & 0b111;
  const byteLength = rm32ModRmByteLengthAt(reader, eip);

  if (mod === modRegister) {
    return {
      mod,
      regField,
      rmField,
      rm: { kind: "reg", index: rmField },
      byteLength
    };
  }

  return {
    mod,
    regField,
    rmField,
    rm: { kind: "mem", address: decodeMemAddress(reader, eip, mod, rmField) },
    byteLength
  };
}

function decodeMemAddress(reader: IsaDecodeReader, eip: number, mod: number, rmField: number): EffectiveAddress {
  const sib = rmField === sibRmField ? decodeSib(reader.readU8(eip + 1)) : undefined;
  const displacementEip = sib === undefined ? eip + 1 : eip + 2;

  switch (mod) {
    case 0:
      if (sib !== undefined) {
        const base = sib.baseField === disp32RmField ? undefined : register(sib.baseField);
        const disp = sib.baseField === disp32RmField ? readU32LE(reader, displacementEip) : 0;

        return effectiveAddress(base, sib.index, sib.scale, disp);
      }

      return rmField === disp32RmField
        ? effectiveAddress(undefined, undefined, 1, readU32LE(reader, displacementEip))
        : effectiveAddress(register(rmField), undefined, 1, 0);
    case 1:
      return effectiveAddress(memoryBase(rmField, sib), sib?.index, sib?.scale ?? 1, signedImm8(reader.readU8(displacementEip)));
    case 2:
      return effectiveAddress(
        memoryBase(rmField, sib),
        sib?.index,
        sib?.scale ?? 1,
        signedImm32(readU32LE(reader, displacementEip))
      );
    default:
      throw new Error(`ModRM memory mode out of range: ${mod}`);
  }
}

function effectiveAddress(
  base: Reg32 | undefined,
  index: Reg32 | undefined,
  scale: Scale,
  disp: number
): EffectiveAddress {
  return {
    segment: defaultSegmentForBase(base),
    base,
    index,
    scale: index === undefined ? 1 : scale,
    disp
  };
}

function decodeSib(value: number): Sib {
  return {
    baseField: value & 0b111,
    index: sibIndex(value),
    scale: sibScale(value)
  };
}

function memoryBase(rmField: number, sib: Sib | undefined): Reg32 {
  return register(sib === undefined ? rmField : sib.baseField);
}

function sibScale(value: number): Scale {
  const scale = sibScales[value >>> 6];

  if (scale === undefined) {
    throw new Error(`SIB scale field out of range for byte 0x${value.toString(16)}`);
  }

  return scale;
}

function sibIndex(value: number): Reg32 | undefined {
  const field = (value >>> 3) & 0b111;

  return field === noIndexField ? undefined : register(field);
}

function register(value: number): Reg32 {
  const reg = reg32[value & 0b111];

  if (reg === undefined) {
    throw new Error(`register encoding out of range for ModRM byte 0x${value.toString(16)}`);
  }

  return reg;
}
