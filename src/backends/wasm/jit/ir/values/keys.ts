import { i32 } from "#x86/numeric.js";
import { simplifyValue } from "./simplify.js";
import {
  flagWriteCellEntries,
  flagWriteConditionEntries
} from "./flags.js";
import { normalizeU32Mask } from "./bits.js";
import { jitArchitecturalSlotKey } from "./slots.js";
import type { JitValue } from "./types.js";

export function valueKey(value: JitValue): string {
  const simplified = simplifyValue(value);

  if (simplified !== value) {
    return valueKey(simplified);
  }

  switch (value.kind) {
    case "const":
      return `const:${value.type}:${i32(value.value)}`;
    case "loadResult":
      return `loadResult:${value.type}:${value.id}`;
    case "input":
      return `input:${jitArchitecturalSlotKey(value.slot)}`;
    case "value.binary":
      return `binary:${value.type}:${value.operator}:${valueKey(value.a)}:${valueKey(value.b)}`;
    case "value.unary":
      return `unary:${value.type}:${value.operator}:${valueKey(value.value)}`;
    case "value.select":
      return `select:${value.type}:${valueKey(value.condition)}:${valueKey(value.whenTrue)}:${valueKey(value.whenFalse)}`;
    case "extractBits":
      return `extractBits:${value.bitOffset}:${value.width}:${valueKey(value.value)}`;
    case "insertBits":
      return `insertBits:${value.bitOffset}:${value.width}:${valueKey(value.base)}:${valueKey(value.value)}`;
    case "extractMaskedBits":
      return `extractMaskedBits:${normalizeU32Mask(value.mask, "extractMaskedBits mask")}:${valueKey(value.value)}`;
    case "insertMaskedBits":
      return `insertMaskedBits:${normalizeU32Mask(value.mask, "insertMaskedBits mask")}:${valueKey(value.base)}:${valueKey(value.value)}`;
    case "value.compare":
      return `compare:${value.type}:${value.operator}:${value.width}:${valueKey(value.a)}:${valueKey(value.b)}`;
    case "flagWrite":
      return `flagWrite:${value.mask}:${jitFlagWriteCellKey(value)}:${jitFlagWriteConditionKey(value)}`;
    case "flagCondition":
      return `flagCondition:${value.cc}:${valueKey(value.flags)}`;
  }
}

function jitFlagWriteCellKey(value: JitValue & { kind: "flagWrite" }): string {
  return flagWriteCellEntries(value)
    .map(([flag, cell]) => `${flag}=${cell.kind === "undef" ? "undef" : valueKey(cell.value)}`)
    .join(",");
}

function jitFlagWriteConditionKey(value: JitValue & { kind: "flagWrite" }): string {
  return flagWriteConditionEntries(value)
    .map(([cc, condition]) => `${cc}=${valueKey(condition)}`)
    .join(",");
}
