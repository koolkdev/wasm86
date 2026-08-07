import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { WasmValuesBuilder } from "../../builder.js";

test("binary operations derive required-bit facts at their Wasm integer width", () => {
  const values = new WasmValuesBuilder();
  const byte = values.producerOutput("i32", 0, { unsigned: 8, signed: 9 });
  const word = values.producerOutput("i32", 0, { unsigned: 16, signed: 17 });
  const word64 = values.producerOutput("i64", 0, { unsigned: 16, signed: 17 });
  const narrowAnd = values.binary("and", byte, word);
  const shifted = values.binary("shl", byte, values.constant(2));
  const shifted64 = values.binary("shr_u", word64, values.constant64(8n));

  deepStrictEqual(values.requiredBits(narrowAnd), { unsigned: 8, signed: 9 });
  deepStrictEqual(values.requiredBits(shifted), { unsigned: 10, signed: 11 });
  deepStrictEqual(values.requiredBits(shifted64), { unsigned: 8, signed: 9 });
});
