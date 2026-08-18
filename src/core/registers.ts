import { assert } from "#common/assert.js";
import {
  reg32,
  type OperandWidth,
  type RegisterAlias,
  type RegisterNameForWidth,
  type Reg8,
  type Reg16,
  type Reg32,
  type RegName
} from "./types.js";

// Rows follow the three-bit register code used by ModR/M and opcode fields.
const aliases: Readonly<{
  8: readonly RegisterAlias<Reg8>[];
  16: readonly RegisterAlias<Reg16>[];
  32: readonly RegisterAlias<Reg32>[];
}> = {
  8: [
    { name: "al", base: "eax", bitOffset: 0, width: 8 },
    { name: "cl", base: "ecx", bitOffset: 0, width: 8 },
    { name: "dl", base: "edx", bitOffset: 0, width: 8 },
    { name: "bl", base: "ebx", bitOffset: 0, width: 8 },
    { name: "ah", base: "eax", bitOffset: 8, width: 8 },
    { name: "ch", base: "ecx", bitOffset: 8, width: 8 },
    { name: "dh", base: "edx", bitOffset: 8, width: 8 },
    { name: "bh", base: "ebx", bitOffset: 8, width: 8 }
  ],
  16: [
    { name: "ax", base: "eax", bitOffset: 0, width: 16 },
    { name: "cx", base: "ecx", bitOffset: 0, width: 16 },
    { name: "dx", base: "edx", bitOffset: 0, width: 16 },
    { name: "bx", base: "ebx", bitOffset: 0, width: 16 },
    { name: "sp", base: "esp", bitOffset: 0, width: 16 },
    { name: "bp", base: "ebp", bitOffset: 0, width: 16 },
    { name: "si", base: "esi", bitOffset: 0, width: 16 },
    { name: "di", base: "edi", bitOffset: 0, width: 16 }
  ],
  32: [
    { name: "eax", base: "eax", bitOffset: 0, width: 32 },
    { name: "ecx", base: "ecx", bitOffset: 0, width: 32 },
    { name: "edx", base: "edx", bitOffset: 0, width: 32 },
    { name: "ebx", base: "ebx", bitOffset: 0, width: 32 },
    { name: "esp", base: "esp", bitOffset: 0, width: 32 },
    { name: "ebp", base: "ebp", bitOffset: 0, width: 32 },
    { name: "esi", base: "esi", bitOffset: 0, width: 32 },
    { name: "edi", base: "edi", bitOffset: 0, width: 32 }
  ]
};

const aliasesByName = new Map<RegName, RegisterAlias>(
  Object.values(aliases).flatMap((row) => row.map((alias) => [alias.name, alias]))
);

export function registerAlias<Name extends RegName>(name: Name): RegisterAlias<Name> {
  const alias = aliasesByName.get(name);
  assert(alias !== undefined, `register alias is missing: ${name}`);

  return alias as RegisterAlias<Name>;
}

export function registerAliasByIndex<Width extends OperandWidth>(
  width: Width,
  index: number
): RegisterAlias<RegisterNameForWidth<Width>> {
  const alias = aliases[width][index & 0b111];
  assert(alias !== undefined, `register alias index is missing: ${width}:${index & 0b111}`);

  return alias as RegisterAlias<RegisterNameForWidth<Width>>;
}

export function reg32Index(reg: Reg32): number {
  const index = reg32.indexOf(reg);
  assert(index !== -1, `r32 register is missing: ${reg}`);

  return index;
}
