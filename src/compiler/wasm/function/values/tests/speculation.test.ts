import { strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmValuesBuilder } from "../builder.js";

test("integer division requires a known nonzero divisor for speculation", () => {
  const values = new WasmValuesBuilder();
  const dividend = values.parameter(0, "i32");
  const dynamicDivisor = values.parameter(1, "i32");
  const dynamic = values.binary("div_u", dividend, dynamicDivisor);
  const zero = values.binary("div_u", dividend, values.constant(0));
  const nonzero = values.binary("div_u", dividend, values.constant(3));
  const graph = values.finish();

  strictEqual(graph.canSpeculateInstruction(dynamic), false);
  strictEqual(graph.canSpeculateInstruction(zero), false);
  strictEqual(graph.canSpeculateInstruction(nonzero), true);
});

test("signed division by minus one uses the dividend's established range", () => {
  const values = new WasmValuesBuilder();
  const full = values.parameter(0, "i32");
  const narrow = values.producerOutput("i32", { unsigned: 8, signed: 9 });
  const minimum = values.constant(-0x8000_0000);
  const nearMinimum = values.constant(-0x7fff_ffff);
  const minusOne = values.constant(-1);
  const fullDivision = values.binary("div_s", full, minusOne);
  const narrowDivision = values.binary("div_s", narrow, minusOne);
  const minimumDivision = values.binary("div_s", minimum, minusOne);
  const nearMinimumDivision = values.binary("div_s", nearMinimum, minusOne);
  const minimum64 = values.constant64(-0x8000_0000_0000_0000n);
  const minimum64Division = values.binary("div_s", minimum64, values.constant64(-1n));
  const graph = values.finish();

  strictEqual(graph.canSpeculateInstruction(fullDivision), false);
  strictEqual(graph.canSpeculateInstruction(narrowDivision), true);
  strictEqual(graph.canSpeculateInstruction(minimumDivision), false);
  strictEqual(graph.canSpeculateInstruction(nearMinimumDivision), true);
  strictEqual(graph.canSpeculateInstruction(minimum64Division), false);
});

test("signed remainder permits the minimum dividend with a minus-one divisor", () => {
  const values = new WasmValuesBuilder();
  const minimum = values.constant(-0x8000_0000);
  const remainder = values.binary("rem_s", minimum, values.constant(-1));
  const graph = values.finish();

  strictEqual(graph.canSpeculateInstruction(remainder), true);
});

test("unreachable cannot be speculated while floating-point division can", () => {
  const values = new WasmValuesBuilder();
  const unreachable = values.unreachable("i32");
  const left = values.parameter(0, "f32");
  const right = values.parameter(1, "f32");
  const quotient = values.binary("div", left, right);
  const graph = values.finish();

  strictEqual(graph.canSpeculateInstruction(unreachable), false);
  strictEqual(graph.canSpeculateInstruction(quotient), true);
});
