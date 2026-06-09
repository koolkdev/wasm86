import {
  flagWriteCellEntries,
  flagWriteConditionEntries
} from "./flags.js";
import {
  jitArchitecturalSlotsEqual
} from "./slots.js";
import {
  normalizeU32Mask
} from "./bits.js";
import { simplifyValue } from "./simplify.js";
import type {
  JitBinaryValue,
  JitCompareValue,
  JitConstValue,
  JitExtractBitsValue,
  JitExtractMaskedBitsValue,
  JitFlagConditionValue,
  JitFlagWriteValue,
  JitInputValue,
  JitInsertBitsValue,
  JitInsertMaskedBitsValue,
  JitLoadResultValue,
  JitSelectValue,
  JitUnaryValue,
  JitValue
} from "./types.js";

export function valuesEqual(a: JitValue, b: JitValue): boolean {
  return valuesEqualStructural(simplifyValue(a), simplifyValue(b));
}

function valuesEqualStructural(a: JitValue, b: JitValue): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "value.binary": {
      const binary = b as JitBinaryValue;

      return a.type === binary.type &&
        a.operator === binary.operator &&
        valuesEqual(a.a, binary.a) &&
        valuesEqual(a.b, binary.b);
    }
    case "value.unary": {
      const unary = b as JitUnaryValue;

      return a.type === unary.type &&
        a.operator === unary.operator &&
        valuesEqual(a.value, unary.value);
    }
    case "value.select": {
      const select = b as JitSelectValue;

      return a.type === select.type &&
        valuesEqual(a.condition, select.condition) &&
        valuesEqual(a.whenTrue, select.whenTrue) &&
        valuesEqual(a.whenFalse, select.whenFalse);
    }
    case "const": {
      const constant = b as JitConstValue;

      return a.type === constant.type && a.value === constant.value;
    }
    case "loadResult": {
      const loadResult = b as JitLoadResultValue;

      return a.id === loadResult.id && a.type === loadResult.type;
    }
    case "input":
      return jitArchitecturalSlotsEqual(a.slot, (b as JitInputValue).slot);
    case "extractBits": {
      const extract = b as JitExtractBitsValue;

      return a.bitOffset === extract.bitOffset &&
        a.width === extract.width &&
        valuesEqual(a.value, extract.value);
    }
    case "insertBits": {
      const insert = b as JitInsertBitsValue;

      return a.bitOffset === insert.bitOffset &&
        a.width === insert.width &&
        valuesEqual(a.base, insert.base) &&
        valuesEqual(a.value, insert.value);
    }
    case "extractMaskedBits": {
      const extract = b as JitExtractMaskedBitsValue;

      return normalizeU32Mask(a.mask, "extractMaskedBits mask") ===
        normalizeU32Mask(extract.mask, "extractMaskedBits mask") &&
        valuesEqual(a.value, extract.value);
    }
    case "insertMaskedBits": {
      const insert = b as JitInsertMaskedBitsValue;

      return normalizeU32Mask(a.mask, "insertMaskedBits mask") ===
        normalizeU32Mask(insert.mask, "insertMaskedBits mask") &&
        valuesEqual(a.base, insert.base) &&
        valuesEqual(a.value, insert.value);
    }
    case "value.compare": {
      const compare = b as JitCompareValue;

      return a.type === compare.type &&
        a.operator === compare.operator &&
        a.width === compare.width &&
        valuesEqual(a.a, compare.a) &&
        valuesEqual(a.b, compare.b);
    }
    case "flagWrite":
      return jitFlagWritesEqual(a, b as JitFlagWriteValue);
    case "flagCondition": {
      const condition = b as JitFlagConditionValue;

      return a.cc === condition.cc && valuesEqual(a.flags, condition.flags);
    }
  }
}

function jitFlagWritesEqual(left: JitFlagWriteValue, right: JitFlagWriteValue): boolean {
  if (left.mask !== right.mask) {
    return false;
  }

  const leftCells = flagWriteCellEntries(left);
  const rightCells = flagWriteCellEntries(right);

  if (leftCells.length !== rightCells.length) {
    return false;
  }

  for (const [index, [flag, cell]] of leftCells.entries()) {
    const [rightFlag, rightCell] = rightCells[index]!;

    if (flag !== rightFlag || cell.kind !== rightCell.kind) {
      return false;
    }

    if (cell.kind === "expr" && rightCell.kind === "expr" && !valuesEqual(cell.value, rightCell.value)) {
      return false;
    }
  }

  const leftConditions = flagWriteConditionEntries(left);
  const rightConditions = flagWriteConditionEntries(right);

  if (leftConditions.length !== rightConditions.length) {
    return false;
  }

  return leftConditions.every(([cc, condition], index) => {
    const [rightCc, rightCondition] = rightConditions[index]!;

    return cc === rightCc && valuesEqual(condition, rightCondition);
  });
}
