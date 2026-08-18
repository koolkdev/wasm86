import type { BitValue, Integer } from "#compiler/function/values.js";
import {
  addFlagSource,
  logicFlagSource,
  statusFlagValuesForSource,
  type SimpleFlagSource
} from "../sources.js";

export function simpleFlagSourceTypeContract(
  byte: Integer<8>,
  word: Integer<16>,
  undefinedAF: BitValue
): void {
  const add: SimpleFlagSource<8> = addFlagSource({
    left: byte,
    right: byte,
    result: byte
  });
  const logic: SimpleFlagSource<16> = logicFlagSource({
    result: word
  });

  statusFlagValuesForSource(add, { undefinedAF });
  statusFlagValuesForSource(logic, { undefinedAF });

  addFlagSource({
    left: word,
    // @ts-expect-error source values must match the primary value's width.
    right: byte,
    result: word
  });
}
