import { ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildVariant } from "#compiler/ir/builder/variant.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import {
  VariantFieldRef,
  VariantRef,
  createVariantLayout,
  variantSet
} from "#compiler/layout/variant.js";

test("variant building combines constants before dynamic fields", () => {
  const low = new VariantFieldRef("build.variant.mixed.low", "u8");
  const middle = new VariantFieldRef("build.variant.mixed.middle", "u16");
  const high = new VariantFieldRef("build.variant.mixed.high", "u8");
  const mixed = new VariantRef("build.variant.mixed", [low, middle, high]);
  const layout = createVariantLayout("build.variant", [
    variantSet("build.variant", [mixed])
  ]);
  const values = new ValueTable();
  const dynamic = values.parameter(0, "i32");
  const result = buildVariant(values, layout, {
    variant: mixed,
    payload: [
      { field: low, value: values.const(0x12) },
      { field: middle, value: dynamic },
      { field: high, value: values.const(0x34) }
    ]
  });
  const root = values.node(result);

  ok(root.kind === "binary");
  strictEqual(root.operator, "or");

  const field = values.node(root.a);

  ok(field.kind === "binary");
  strictEqual(field.operator, "shl");

  const constant = values.node(root.b);

  ok(constant.kind === "const64");
  strictEqual(
    constant.value,
    (BigInt(layout.variant(mixed).tag) << BigInt(layout.tagOffset * 8)) |
      (0x12n << BigInt(layout.field(low).offset * 8)) |
      (0x34n << BigInt(layout.field(high).offset * 8))
  );

  const constantResult = buildVariant(values, layout, {
    variant: mixed,
    payload: [
      { field: low, value: values.const(-1) },
      { field: middle, value: values.const(0x5678) },
      { field: high, value: values.const(0x34) }
    ]
  });
  const constantRoot = values.node(constantResult);

  ok(constantRoot.kind === "const64");
  strictEqual(
    constantRoot.value,
    (BigInt(layout.variant(mixed).tag) << BigInt(layout.tagOffset * 8)) |
      (0xffn << BigInt(layout.field(low).offset * 8)) |
      (0x5678n << BigInt(layout.field(middle).offset * 8)) |
      (0x34n << BigInt(layout.field(high).offset * 8))
  );
});
