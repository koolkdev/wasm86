import { foldFloatBinary, foldFloatCompare } from "./float/fold.js";
import {
  foldBitCount,
  foldBinary,
  foldComparison,
  foldExtend,
  foldSelect,
  foldTruncate,
  foldZeroTest,
  integerOperandFact
} from "./integer/fold-rules.js";
import type { ValueRecord, ZeroTestOperator } from "./record.js";

export type ValueResolution = Readonly<{
  identity: number;
  record: ValueRecord;
}>;

// Operand positions are declaration order: select is condition, whenTrue, whenFalse.
export type FoldOutcome =
  | Readonly<{ kind: "constant"; value: bigint }>
  | Readonly<{ kind: "constantBits"; bits: number | bigint }>
  | Readonly<{ kind: "operand"; which: "a" | "b" | "c" }>
  | Readonly<{ kind: "unreachable" }>
  | Readonly<{ kind: "zeroTest"; operator: ZeroTestOperator; operand: "a" | "b" }>
  | undefined;

// aIsB is value identity, so folds compare identities and never references.
export function foldExpression(
  record: ValueRecord,
  a: ValueResolution | undefined,
  b: ValueResolution | undefined,
  c: ValueResolution | undefined
): FoldOutcome {
  switch (record.op) {
    case "integer.binary":
      return foldBinary(
        record.attr,
        record.a.width,
        integerOperandFact(a?.record),
        integerOperandFact(b?.record),
        a?.identity === b?.identity
      );
    case "float.binary":
      return foldFloatBinary(record.attr, record.width, a?.record, b?.record);
    case "integer.compare":
      return foldComparison(
        record.attr,
        record.a.width,
        integerOperandFact(a?.record),
        integerOperandFact(b?.record),
        a?.identity === b?.identity
      );
    case "float.compare":
      return foldFloatCompare(record.attr, record.a.width, a?.record, b?.record);
    case "integer.zeroTest":
      return foldZeroTest(record.attr, record.a.width, integerOperandFact(a?.record));
    case "integer.bitCount":
      return foldBitCount(record.attr, record.a.width, integerOperandFact(a?.record));
    case "integer.extend":
      return foldExtend(record.width, record.a.width, record.attr, integerOperandFact(a?.record));
    case "integer.truncate":
      return foldTruncate(record.width, integerOperandFact(a?.record));
    case "integer.select":
    case "float.select":
      return foldSelect(integerOperandFact(a?.record), b?.identity === c?.identity);
    default:
      return undefined;
  }
}

export function expressionKey(
  record: ValueRecord,
  a: ValueResolution | undefined,
  b: ValueResolution | undefined,
  c: ValueResolution | undefined
): string {
  return `${record.op}:${record.width}:${String(record.attr)}:${a?.identity ?? ""}:${b?.identity ?? ""}:${c?.identity ?? ""}`;
}
