import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmValuesBuilder } from "../builder.js";

test("identical operations share independently of speculation safety", () => {
  const values = new WasmValuesBuilder();
  const source = values.parameter(0, "i32");
  const mask = values.constant(0xff);
  const firstMask = values.binary("and", source, mask);
  const secondMask = values.binary("and", source, mask);
  const differentOperator = values.binary("or", source, mask);
  const reversedInputs = values.binary("and", mask, source);
  const divisor = values.parameter(1, "i32");
  const firstQuotient = values.binary("div_u", source, divisor);
  const secondQuotient = values.binary("div_u", source, divisor);
  const two = values.constant(2);
  const firstSafeQuotient = values.binary("div_u", source, two);
  const secondSafeQuotient = values.binary("div_u", source, two);
  const firstDependent = values.binary("add", firstQuotient, mask);
  const sameDependent = values.binary("add", firstQuotient, mask);
  const secondDependent = values.binary("add", secondQuotient, mask);
  const zero = values.constant(0);
  const firstAlways = values.binary("div_u", source, zero);
  const secondAlways = values.binary("div_u", source, zero);

  strictEqual(firstMask, secondMask);
  notStrictEqual(firstMask, differentOperator);
  notStrictEqual(firstMask, reversedInputs);
  strictEqual(firstQuotient, secondQuotient);
  strictEqual(firstSafeQuotient, secondSafeQuotient);
  strictEqual(firstDependent, sameDependent);
  strictEqual(firstDependent, secondDependent);
  strictEqual(firstAlways, secondAlways);
});

test("canonical leaves share while produced values preserve occurrence identity", () => {
  const values = new WasmValuesBuilder();
  const i32Constant = values.constant(7);
  const i64Constant = values.constant64(7n);

  strictEqual(i32Constant, values.constant(7));
  strictEqual(i64Constant, values.constant64(7n));
  notStrictEqual(i32Constant, i64Constant);
  strictEqual(values.parameter(0, "i32"), values.parameter(0, "i32"));
  strictEqual(values.unreachable("i32"), values.unreachable("i32"));
  notStrictEqual(values.producerOutput("i32", 0), values.producerOutput("i32", 0));
  notStrictEqual(values.loopInput("i32", 1), values.loopInput("i32", 1));
});

test("graph construction retains exact Wasm operations", () => {
  const values = new WasmValuesBuilder();
  const source = values.parameter(0, "i32");
  const other = values.parameter(1, "i32");
  const condition = values.parameter(2, "i32");
  const sum = values.binary("add", source, other);
  const leadingZeroes = values.unary("clz", source);
  const equal = values.compare("eq", source, other);
  const zero = values.eqz(source);
  const wide = values.convert("extend_i32_u", source);
  const selected = values.select(condition, source, other);
  const { graph } = values.finish();

  deepStrictEqual(graph.node(sum), {
    kind: "binary",
    inputs: [source, other],
    type: "i32",
    operator: "add"
  });
  deepStrictEqual(graph.node(leadingZeroes), {
    kind: "unary",
    inputs: [source],
    type: "i32",
    operator: "clz"
  });
  deepStrictEqual(graph.node(equal), {
    kind: "compare",
    inputs: [source, other],
    type: "i32",
    inputType: "i32",
    operator: "eq"
  });
  deepStrictEqual(graph.node(zero), {
    kind: "eqz",
    inputs: [source],
    type: "i32",
    inputType: "i32"
  });
  deepStrictEqual(graph.node(wide), {
    kind: "convert",
    inputs: [source],
    type: "i64",
    operator: "extend_i32_u"
  });
  deepStrictEqual(graph.node(selected), {
    kind: "select",
    inputs: [source, other, condition],
    type: "i32"
  });
});
