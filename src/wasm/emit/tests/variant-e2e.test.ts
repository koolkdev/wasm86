import { strictEqual } from "node:assert";
import { test } from "node:test";

import { buildVariant } from "#compiler/ir/values/variant.js";
import {
  decodeVariant,
  encodeVariant
} from "#compiler/layout/variant-codec.js";
import {
  VariantFieldRef,
  VariantRef,
  createVariantLayout,
  variantSet
} from "#compiler/layout/variant.js";
import { buildIrBlock } from "#ir/region-builder.js";
import { instantiateIrBlock } from "./harness.js";

test("generated and host encoders share one resolved variant codec", async () => {
  const address = new VariantFieldRef("generated.exit.fault.address", "u32");
  const detail = new VariantFieldRef("generated.exit.fault.detail", "u16");
  const fault = new VariantRef("generated.exit.fault", [address, detail]);
  const layout = createVariantLayout("generated.exit", [
    variantSet("generated.exit", [
      new VariantRef("generated.exit.empty", []),
      fault
    ])
  ]);
  const block = buildIrBlock((body) => {
    const result = buildVariant(body.values, layout, {
      variant: fault,
      payload: [
        { field: address, value: body.values.external(0) },
        { field: detail, value: body.values.external(1) }
      ]
    });

    body.finish({ kind: "exit", result });
  });
  const instance = await instantiateIrBlock(block, 2);
  const generated = instance.run(-4, 0x8001);
  const host = encodeVariant(layout, {
    variant: fault,
    payload: [
      { field: address, value: 0xffff_fffc },
      { field: detail, value: 0x8001 }
    ]
  });
  const decoded = decodeVariant(layout, generated);

  strictEqual(generated, host);
  strictEqual(decoded.variant, fault);
  strictEqual(decoded.value(address), 0xffff_fffc);
  strictEqual(decoded.value(detail), 0x8001);
});
