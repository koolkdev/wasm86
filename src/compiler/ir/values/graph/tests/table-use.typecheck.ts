import type { AnyValueHandle } from "#compiler/ir/values/handle.js";
import type { Integer, I32Value, I64Value } from "#compiler/ir/values.js";
import type { ValueId } from "#compiler/value.js";
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

  // @ts-expect-error identity comparisons preserve exact semantic widths.
  target.sameValue(narrow, byte);
  // @ts-expect-error identity comparisons preserve exact semantic widths.
  target.sameValue(narrow, wide);

  void [id, ids, pair, byteId, sameNarrow];
}

export function valueInputTypeContract(inputs: ValueInputs, value: I32Value): void {
  const id: ValueId = inputs.value(value);

  // @ts-expect-error operation inputs resolve dependencies but cannot create graph nodes.
  inputs.create;

  void id;
}
