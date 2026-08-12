import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmValuesBuilder } from "../builder.js";

test("canonical sources share while produced values preserve occurrence identity", () => {
  const values = new WasmValuesBuilder();
  const i32Constant = values.constant(7);
  const i64Constant = values.constant64(7n);
  const positiveZero = values.constantBits("f32", 0);
  const negativeZero = values.constantBits("f32", 0x8000_0000);

  strictEqual(i32Constant, values.constant(7));
  strictEqual(i64Constant, values.constant64(7n));
  notStrictEqual(i32Constant, i64Constant);
  strictEqual(positiveZero, values.constantBits("f32", 0));
  notStrictEqual(positiveZero, negativeZero);
  strictEqual(values.parameter(0, "i32"), values.parameter(0, "i32"));
  strictEqual(values.unreachable("i32"), values.unreachable("i32"));
  notStrictEqual(values.producerOutput("i32"), values.producerOutput("i32"));
  notStrictEqual(values.loopInput("i32"), values.loopInput("i32"));
});
