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

test("equivalent Wasm expressions share without erasing operation shape", () => {
  const values = new WasmValuesBuilder();
  const source = values.parameter(0, "i32");
  const other = values.parameter(1, "i32");
  const condition = values.parameter(2, "i32");
  const sum = values.binary("add", source, other);

  strictEqual(sum, values.binary("add", source, other));
  notStrictEqual(sum, values.binary("sub", source, other));
  notStrictEqual(sum, values.binary("add", other, source));
  strictEqual(values.unary("clz", source), values.unary("clz", source));
  strictEqual(values.compare("eq", source, other), values.compare("eq", source, other));
  notStrictEqual(values.compare("eq", source, other), values.compare("ne", source, other));
  strictEqual(values.eqz(source), values.eqz(source));
  strictEqual(values.convert("extend_i32_u", source), values.convert("extend_i32_u", source));
  strictEqual(values.select(condition, source, other), values.select(condition, source, other));
  notStrictEqual(values.select(condition, source, other), values.select(condition, other, source));

  const floatLeft = values.parameter(3, "f32");
  const floatRight = values.parameter(4, "f32");

  strictEqual(
    values.binary("add", floatLeft, floatRight),
    values.binary("add", floatLeft, floatRight)
  );
  strictEqual(
    values.compare("lt", floatLeft, floatRight),
    values.compare("lt", floatLeft, floatRight)
  );
});
