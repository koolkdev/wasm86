import type { AnyValueHandle } from "#compiler/ir/values/handle.js";
import {
  Integer,
  type Integer as IntegerValue,
  type I32Value,
  type I64Value
} from "#compiler/ir/values.js";
import type { ValueId } from "#compiler/ir/value.js";
import type { ValueInputs } from "../../expression.js";
import type { ValueTable } from "../table.js";

export function tableUseTypeContract(
  target: ValueTable,
  value: AnyValueHandle,
  narrow: I32Value,
  wide: I64Value,
  byte: Integer<8>
): void {
  const id: ValueId = target.use(value);
  const ids: readonly ValueId[] = target.use([value]);
  const pair: readonly [ValueId, ValueId] = target.use([narrow, wide]);
  const byteId: ValueId = target.use(byte);
  const sameNarrow: boolean = target.sameValue(narrow, narrow);
  const differentLogicalWidths: boolean = target.sameValue(narrow, byte);
  const differentWidths: boolean = target.sameValue(narrow, wide);

  void [id, ids, pair, byteId, sameNarrow, differentLogicalWidths, differentWidths];
}

export function valueInputTypeContract(inputs: ValueInputs, value: I32Value): void {
  const id: ValueId = inputs.value(value);

  // @ts-expect-error operation inputs resolve dependencies but cannot create graph nodes.
  inputs.create;

  void id;
}

export function typedHandlesContract(target: ValueTable, byteId: ValueId, wideId: ValueId): void {
  const [byte, wide] = target.handles([Integer[8], Integer[64]], [byteId, wideId]);
  const exactByte: IntegerValue<8> = byte;
  const exactWide: IntegerValue<64> = wide;

  void [exactByte, exactWide];
}
