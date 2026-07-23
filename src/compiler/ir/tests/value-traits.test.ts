import { strictEqual } from "node:assert";
import { test } from "node:test";

import { ValueTable } from "#compiler/ir/values/table.js";

test("ordinary values are nontrapping while unreachable values trap", () => {
  const values = new ValueTable();
  const input = values.parameter(0, "i32");

  strictEqual(values.isNonTrapping(values.const(1)), true);
  strictEqual(values.isNonTrapping(input), true);
  strictEqual(values.isNonTrapping(values.binary("add", input, values.const(1))), true);
  strictEqual(values.isNonTrapping(values.unreachable()), false);
});

test("division is nontrapping only when its divisor rules out a trap", () => {
  const values = new ValueTable();
  const dividend = values.parameter(0, "i32");

  strictEqual(
    values.isNonTrapping(values.binary("div_u", dividend, values.parameter(1, "i32"))),
    false
  );
  strictEqual(
    values.isNonTrapping(values.binary("div_u", dividend, values.const(17))),
    true
  );
  strictEqual(
    values.isNonTrapping(values.binary("div_s", dividend, values.const(-1))),
    false
  );
});

test("trapping inputs remain trapping through otherwise safe expressions", () => {
  const values = new ValueTable();
  const dividend = values.parameter(0, "i32");
  const quotient = values.binary("div_u", dividend, values.parameter(1, "i32"));
  const adjusted = values.binary("add", quotient, values.const(1));
  const compared = values.compare(32, "ne", adjusted, values.const(0));

  strictEqual(values.isNonTrapping(adjusted), false);
  strictEqual(values.isNonTrapping(compared), false);
});

test("select is trapping when any eagerly evaluated input can trap", () => {
  const values = new ValueTable();
  const safe = values.parameter(0, "i32");
  const trapping = values.binary("rem_s", safe, values.parameter(1, "i32"));

  strictEqual(values.isNonTrapping(values.select(safe, values.const(1), values.const(0))), true);
  strictEqual(values.isNonTrapping(values.select(safe, trapping, values.const(0))), false);
});
