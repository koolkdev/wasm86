import { defaultSegmentForBase } from "#core/segments.js";
import type { Reg32 } from "#core/types.js";
import type {
  AddressBase,
  Displacement,
  MemoryAddress,
  ModRm32Model,
  ModRmMode
} from "./types.js";

const noDisplacement = { byteLength: 0, signed: false } as const;
const signedDisp8 = { byteLength: 1, signed: true } as const;
const signedDisp32 = { byteLength: 4, signed: true } as const;
const unsignedDisp32 = { byteLength: 4, signed: false } as const;

export function buildModRm32(): ModRm32Model {
  return {
    modes: [
      memoryMode(noDisplacement, unsignedDisp32),
      memoryMode(signedDisp8, signedDisp8),
      memoryMode(signedDisp32, signedDisp32),
      { kind: "register" }
    ],
    sibIndexes: [
      "eax",
      "ecx",
      "edx",
      "ebx",
      undefined,
      "ebp",
      "esi",
      "edi"
    ],
    sibScales: [1, 2, 4, 8]
  };
}

function memoryMode(
  displacement: Displacement,
  baseLessDisplacement: Displacement
): ModRmMode {
  const encodedBase5 = displacement.byteLength === 0
    ? addressBase(undefined, baseLessDisplacement)
    : addressBase("ebp", displacement);

  return {
    kind: "memory",
    rm: [
      directAddress("eax", displacement),
      directAddress("ecx", displacement),
      directAddress("edx", displacement),
      directAddress("ebx", displacement),
      {
        kind: "sib",
        bases: [
          addressBase("eax", displacement),
          addressBase("ecx", displacement),
          addressBase("edx", displacement),
          addressBase("ebx", displacement),
          addressBase("esp", displacement),
          encodedBase5,
          addressBase("esi", displacement),
          addressBase("edi", displacement)
        ]
      },
      { kind: "base", address: encodedBase5 },
      directAddress("esi", displacement),
      directAddress("edi", displacement)
    ]
  };
}

function directAddress(
  base: Reg32 | undefined,
  displacement: Displacement
): MemoryAddress {
  return { kind: "base", address: addressBase(base, displacement) };
}

function addressBase(
  base: Reg32 | undefined,
  displacement: Displacement
): AddressBase {
  return {
    base,
    displacement,
    defaultSegment: defaultSegmentForBase(base)
  };
}
