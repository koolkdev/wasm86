import type { OperandWidth, RegisterAlias, RegName } from "./types.js";

export const registerAliasesByWidth = {
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
} as const satisfies Readonly<Record<OperandWidth, readonly RegisterAlias[]>>;

const registerAliasesByName = new Map<RegName, RegisterAlias>(
  Object.values(registerAliasesByWidth).flatMap((aliases) => aliases.map((alias) => [alias.name, alias]))
);

export function registerAlias(name: RegName): RegisterAlias {
  const alias = registerAliasesByName.get(name);

  if (alias === undefined) {
    throw new Error(`unknown register alias: ${name}`);
  }

  return alias;
}

export function registerAliasByIndex(width: OperandWidth, index: number): RegisterAlias {
  const alias = registerAliasesByWidth[width][index & 0b111];

  if (alias === undefined) {
    throw new Error(`register alias index out of range: ${index}`);
  }

  return alias;
}
