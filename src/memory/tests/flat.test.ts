import {
  deepStrictEqual,
  notStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { ValueTable } from "#compiler/ir/values/table.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  flatMemoryAccess,
  flatMemoryOperand,
  guestMemoryResource
} from "#memory/flat.js";

test("a static-length flat access is one unsigned limit compare", () => {
  const values = new ValueTable();
  const start = values.external(0);
  const byteLength = values.const(4);
  const access = flatMemoryAccess(values, start, byteLength, "write");
  const limit = values.const(guestMemoryMinimumByteLength - 4);

  deepStrictEqual(values.node(access.invalid), {
    kind: "compare",
    type: "i32",
    operator: "gt_u",
    a: start,
    b: limit
  });
  strictEqual(access.resource, guestMemoryResource);
  strictEqual(access.start, start);
  strictEqual(access.byteLength, byteLength);
  deepStrictEqual(access.fault, { address: start, intent: "write" });
  strictEqual(access.intent, "write");
});

test("a dynamic-length flat access uses the complete nonwrapping predicate", () => {
  const values = new ValueTable();
  const start = values.external(0);
  const byteLength = values.external(1);
  const access = flatMemoryAccess(values, start, byteLength, "read");
  const zero = values.const(0);
  const one = values.const(1);
  const last = values.const(guestMemoryMinimumByteLength - 1);
  const expectedInvalid = values.binary(
    "and",
    values.compare(32, "ne", byteLength, zero),
    values.binary(
      "or",
      values.compare(32, "gt_u", start, last),
      values.compare(
        32,
        "gt_u",
        values.binary("sub", byteLength, one),
        values.binary("sub", last, start)
      )
    )
  );

  strictEqual(access.invalid, expectedInvalid);
  deepStrictEqual(access.fault, { address: start, intent: "read" });
});

test("static flat bounds accept the last range and reject invalid lengths", () => {
  const values = new ValueTable();
  const finalWord = flatMemoryAccess(
    values,
    values.const(guestMemoryMinimumByteLength - 4),
    values.const(4),
    "read"
  );
  const crossingWord = flatMemoryAccess(
    values,
    values.const(guestMemoryMinimumByteLength - 3),
    values.const(4),
    "read"
  );
  const wrappedByte = flatMemoryAccess(
    values,
    values.const(-1),
    values.const(1),
    "read"
  );

  strictEqual(values.constValue(finalWord.invalid), 0);
  strictEqual(values.constValue(crossingWord.invalid), 1);
  strictEqual(values.constValue(wrappedByte.invalid), 1);
  throws(
    () => flatMemoryAccess(values, values.const(0), values.const(0), "read"),
    /flat access byte length must be an integer between 1/
  );
  throws(
    () => flatMemoryAccess(
      values,
      values.const(0),
      values.const(guestMemoryMinimumByteLength + 1),
      "read"
    ),
    /flat access byte length must be an integer between 1/
  );
});

test("flat operands derive address normalization and range facts together", () => {
  const values = new ValueTable();
  const constant = flatMemoryAccess(
    values,
    values.const(0x2000),
    values.const(8),
    "write"
  );
  const dynamic = flatMemoryAccess(
    values,
    values.external(0),
    values.const(8),
    "write"
  );
  const byteOffset = values.const(4);
  const absolute = flatMemoryOperand(values, constant, byteOffset, 32);

  deepStrictEqual(
    absolute.effect,
    {
      space: "resource",
      resource: guestMemoryResource,
      range: {
        basis: { kind: "resource" },
        slice: { byteOffset: 0x2004, byteLength: 4 }
      }
    }
  );
  deepStrictEqual(absolute.address, {
    base: constant.start,
    displacement: 4
  });
  strictEqual(absolute.width, 32);

  const slice = flatMemoryOperand(values, dynamic, byteOffset, 32);

  deepStrictEqual(slice.address, {
    base: dynamic.start,
    displacement: 4
  });
  strictEqual(slice.effect.range.basis.kind, "dynamic");
  if (slice.effect.range.basis.kind === "dynamic") {
    strictEqual(slice.effect.range.basis.origin, dynamic.origin);
  }
  strictEqual(slice.effect.range.slice?.byteOffset, 4);
  strictEqual(slice.effect.range.slice?.byteLength, 4);

  const dynamicOffset = values.external(1);
  const whole = flatMemoryOperand(values, dynamic, dynamicOffset, 32);

  deepStrictEqual(whole.address, {
    base: values.binary("add", dynamic.start, dynamicOffset),
    displacement: 0
  });
  strictEqual(whole.effect.range.basis.kind, "dynamic");
  if (whole.effect.range.basis.kind === "dynamic") {
    strictEqual(whole.effect.range.basis.origin, dynamic.origin);
  }
  strictEqual(whole.effect.range.slice, undefined);

  const wrappingConstant = flatMemoryAccess(
    values,
    values.const(-1),
    values.const(4),
    "write"
  );
  const conservative = flatMemoryOperand(
    values,
    wrappingConstant,
    values.const(0),
    32
  );

  deepStrictEqual(conservative.address, {
    base: wrappingConstant.start,
    displacement: 0
  });
  strictEqual(conservative.effect.range.basis.kind, "dynamic");
  if (conservative.effect.range.basis.kind === "dynamic") {
    strictEqual(conservative.effect.range.basis.origin, wrappingConstant.origin);
  }
  strictEqual(conservative.effect.range.slice?.byteOffset, 0);
  strictEqual(conservative.effect.range.slice?.byteLength, 4);
  notStrictEqual(dynamic.origin, constant.origin);
});

test("flat operands reject invalid widths and constant subranges", () => {
  const values = new ValueTable();
  const access = flatMemoryAccess(
    values,
    values.const(0x2000),
    values.const(4),
    "read"
  );

  throws(
    () => flatMemoryOperand(values, access, values.const(0), 64 as 32),
    /flat operation width must be 8, 16, or 32/
  );
  throws(
    () => flatMemoryOperand(values, access, values.const(-1), 8),
    /memory byte offset must be non-negative/
  );
  throws(
    () => flatMemoryOperand(values, access, values.const(1), 32),
    /32-bit memory access at byte offset 1 exceeds 4-byte resolution/
  );
});
