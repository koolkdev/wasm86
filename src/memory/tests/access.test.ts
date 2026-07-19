import {
  deepStrictEqual,
  ok,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type { Operation } from "#compiler/ir/operations/index.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { guestMemoryAccess } from "#memory/access.js";
import { guestMemoryResource } from "#memory/resource.js";

type OperationOf<Kind extends Operation["kind"]> = Extract<
  Operation,
  { kind: Kind }
>;

type ResourceOperation<Kind extends Operation["kind"]> = OperationOf<Kind>;

test("Memory access construction expands one WRITE access into generic RMW operations", () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const memory = guestMemoryAccess.bind(body);
  const start = values.external(0);
  const byteLength = values.const(8);
  const access = memory.resolve({ start, byteLength }, "write");
  const loaded = memory.read(access, values.const(0), 16, { signed: true });

  memory.write(access, values.const(4), loaded, 32);

  deepStrictEqual(access.range, { start, byteLength });
  deepStrictEqual(access.fault, { address: start, intent: "write" });

  const read = resourceOperations(body, "resource.read")[0];
  const write = resourceOperations(body, "resource.write")[0];

  ok(read !== undefined);
  ok(write !== undefined);
  strictEqual(read.effect.resource, guestMemoryResource);
  strictEqual(write.effect.resource, guestMemoryResource);
  strictEqual(read.width, 16);
  strictEqual(read.signed, true);
  strictEqual(read.displacement, 0);
  strictEqual(write.width, 32);
  strictEqual(write.displacement, 4);
  strictEqual(read.effect.range.basis.kind, "dynamic");
  strictEqual(write.effect.range.basis.kind, "dynamic");

  if (
    read.effect.range.basis.kind === "dynamic" &&
    write.effect.range.basis.kind === "dynamic"
  ) {
    strictEqual(read.effect.range.basis.origin, access.origin);
    strictEqual(write.effect.range.basis.origin, access.origin);
  }

  deepStrictEqual(read.effect.range.slice, {
    byteOffset: 0,
    byteLength: 2
  });
  deepStrictEqual(write.effect.range.slice, {
    byteOffset: 4,
    byteLength: 4
  });
});

test("Memory access construction gives constant instruction fetches absolute ranges", () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const memory = guestMemoryAccess.bind(body);
  const access = memory.resolve(
    { start: values.const(0x2000), byteLength: values.const(4) },
    "instructionFetch"
  );

  memory.read(access, values.const(2), 16, { signed: true });

  const read = resourceOperations(body, "resource.read")[0];

  ok(read !== undefined);
  deepStrictEqual(read.effect.range, {
    basis: { kind: "resource" },
    slice: { byteOffset: 0x2002, byteLength: 2 }
  });
  strictEqual(read.displacement, 2);
  strictEqual(read.signed, true);
  deepStrictEqual(access.fault, {
    address: access.range.start,
    intent: "instructionFetch"
  });
});

test("a parent-created access emits through the child region that consumes it", () => {
  const values = new ValueTable();
  const parent = new RegionBuilder(values);
  const child = parent.child();
  const access = guestMemoryAccess.bind(parent).resolve(
    { start: values.external(0), byteLength: values.const(4) },
    "read"
  );

  guestMemoryAccess.bind(child).read(access, values.const(0), 32);

  strictEqual(parent.build().nodes.length, 0);
  strictEqual(resourceOperations(child, "resource.read").length, 1);
});

function resourceOperations<Kind extends Operation["kind"]>(
  body: RegionBuilder,
  kind: Kind
): readonly ResourceOperation<Kind>[] {
  return body.build().nodes.filter(
    (node) => node.category === "operation" && node.kind === kind
  ) as unknown as readonly ResourceOperation<Kind>[];
}
