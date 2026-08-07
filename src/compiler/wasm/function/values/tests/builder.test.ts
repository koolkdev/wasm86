import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmValueId } from "../nodes.js";
import { WasmValuesBuilder } from "../builder.js";

test("Wasm values form a dependency-topological graph in eager input order", () => {
  const values = new WasmValuesBuilder();
  const condition = values.parameter(0, "i32");
  const source = values.parameter(1, "i32");
  const increment = values.constant(1);
  const sum = values.binary("add", source, increment);
  const result = values.select(condition, sum, source);
  const { graph } = values.finish();

  deepStrictEqual(graph.node(result).inputs, [sum, source, condition]);
  for (let index = 0; index < graph.length; index += 1) {
    const node = graph.node(wasmValueId(index));

    strictEqual(
      node.inputs.every((input) => input < index),
      true
    );
  }
});

test("instruction speculation describes exact Wasm safety", () => {
  const values = new WasmValuesBuilder();
  const dividend = values.producerOutput("i32", 0, {
    unsigned: 8,
    signed: 9
  });
  const two = values.constant(2);
  const zero = values.constant(0);
  const dynamicDivisor = values.parameter(0, "i32");
  const safeQuotient = values.binary("div_u", dividend, two);
  const maybeQuotient = values.binary("div_u", dividend, dynamicDivisor);
  const dependent = values.binary("add", maybeQuotient, two);
  const alwaysQuotient = values.binary("div_u", dividend, zero);
  const unreachable = values.unreachable("i32");
  const { facts } = values.finish();

  strictEqual(facts.instructionCanSpeculate(safeQuotient), true);
  strictEqual(facts.instructionCanSpeculate(maybeQuotient), false);
  strictEqual(facts.instructionCanSpeculate(dependent), true);
  strictEqual(facts.instructionCanSpeculate(alwaysQuotient), false);
  strictEqual(facts.instructionCanSpeculate(unreachable), false);
  strictEqual(facts.recipeCanSpeculate(dynamicDivisor), true);
  strictEqual(facts.recipeCanSpeculate(safeQuotient), true);
  strictEqual(facts.recipeCanSpeculate(maybeQuotient), false);
  strictEqual(facts.recipeCanSpeculate(dependent), false);
  strictEqual(facts.recipeCanSpeculate(unreachable), false);
});

test("signed division can speculate only when zero and overflow traps are ruled out", () => {
  const values = new WasmValuesBuilder();
  const narrowDividend = values.producerOutput("i32", 0, {
    unsigned: 32,
    signed: 8
  });
  const narrowDividend64 = values.producerOutput("i64", 0, {
    unsigned: 64,
    signed: 16
  });
  const unknownDividend = values.parameter(0, "i32");
  const unknownDivisor = values.parameter(1, "i32");
  const minusOne = values.constant(-1);
  const quotient = values.binary("div_s", narrowDividend, values.constant(-1));
  const quotient64 = values.binary("div_s", narrowDividend64, values.constant64(-1n));
  const possibleOverflow = values.binary("div_s", unknownDividend, minusOne);
  const certainOverflow = values.binary("div_s", values.constant(-0x8000_0000), minusOne);
  const possibleZero = values.binary("div_s", narrowDividend, unknownDivisor);
  const minimumRemainder = values.binary("rem_s", values.constant(-0x8000_0000), minusOne);
  const { facts } = values.finish();

  strictEqual(facts.instructionCanSpeculate(quotient), true);
  strictEqual(facts.instructionCanSpeculate(quotient64), true);
  strictEqual(facts.instructionCanSpeculate(possibleOverflow), false);
  strictEqual(facts.instructionCanSpeculate(certainOverflow), false);
  strictEqual(facts.instructionCanSpeculate(possibleZero), false);
  strictEqual(facts.instructionCanSpeculate(minimumRemainder), true);
});

test("loop depth is established as values are constructed", () => {
  const values = new WasmValuesBuilder();
  const parameter = values.parameter(0, "i32");
  const loopOutput = values.producerOutput("i32", 1);
  const dependent = values.binary("add", parameter, loopOutput);
  const nestedLoopInput = values.loopInput("i32", 2);
  const nestedDependent = values.binary("add", dependent, nestedLoopInput);
  const { facts } = values.finish();

  strictEqual(facts.requiredLoopDepth(parameter), 0);
  strictEqual(facts.requiredLoopDepth(loopOutput), 1);
  strictEqual(facts.requiredLoopDepth(dependent), 1);
  strictEqual(facts.requiredLoopDepth(nestedLoopInput), 2);
  strictEqual(facts.requiredLoopDepth(nestedDependent), 2);
});

test("Wasm operations retain Wasm result types and required-bit facts", () => {
  const values = new WasmValuesBuilder();
  const source = values.producerOutput("i32", 0);
  const other = values.producerOutput("i32", 0);
  const signed = values.unary("extend8_s", source);
  const population = values.unary("popcnt", source);
  const equal = values.compare("eq", source, other);
  const wide = values.convert("extend_i32_u", source);
  const zero = values.eqz(wide);
  const widePopulation = values.unary("popcnt", wide);
  const { graph } = values.finish();

  strictEqual(graph.node(signed).type, "i32");
  strictEqual(graph.node(population).type, "i32");
  strictEqual(graph.node(equal).type, "i32");
  strictEqual(graph.node(zero).type, "i32");
  strictEqual(graph.node(wide).type, "i64");
  strictEqual(graph.node(widePopulation).type, "i64");
  deepStrictEqual(values.requiredBits(signed), {
    unsigned: 32,
    signed: 8
  });
  deepStrictEqual(values.requiredBits(population), {
    unsigned: 6,
    signed: 7
  });
  deepStrictEqual(values.requiredBits(equal), {
    unsigned: 1,
    signed: 2
  });
  deepStrictEqual(values.requiredBits(zero), {
    unsigned: 1,
    signed: 2
  });
  deepStrictEqual(values.requiredBits(wide), {
    unsigned: 32,
    signed: 33
  });
  deepStrictEqual(values.requiredBits(widePopulation), {
    unsigned: 7,
    signed: 8
  });
});
