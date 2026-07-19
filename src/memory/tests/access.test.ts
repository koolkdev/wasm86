import {
  deepStrictEqual,
  ok,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type { Operation } from "#compiler/ir/operations/index.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { OpAction } from "#ir/actions.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { MemoryAccessBuilder } from "#memory/access.js";
import { guestMemoryResource } from "#memory/resource.js";

type OperationOf<Kind extends Operation["kind"]> = Extract<
  Operation,
  { kind: Kind }
>;

type ResourceAction<Kind extends Operation["kind"]> = OpAction & Readonly<{
  op: OperationOf<Kind>;
}>;

test("the Memory access builder expands one WRITE access into generic RMW operations", () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const memory = new MemoryAccessBuilder({
    values,
    currentBody: () => body
  });
  const start = values.external(0);
  const byteLength = values.const(8);
  const access = memory.resolve({ start, byteLength }, "write");
  const loaded = memory.read(access, values.const(0), 16, { signed: true });

  memory.write(access, values.const(4), loaded, 32);

  deepStrictEqual(access.range, { start, byteLength });
  deepStrictEqual(access.fault, { address: start, intent: "write" });

  const read = resourceActions(body, "resource.read")[0];
  const write = resourceActions(body, "resource.write")[0];

  ok(read !== undefined);
  ok(write !== undefined);
  strictEqual(read.op.effect.resource, guestMemoryResource);
  strictEqual(write.op.effect.resource, guestMemoryResource);
  strictEqual(read.op.width, 16);
  strictEqual(read.op.signed, true);
  strictEqual(read.op.displacement, 0);
  strictEqual(write.op.width, 32);
  strictEqual(write.op.displacement, 4);
  strictEqual(read.op.effect.range.basis.kind, "dynamic");
  strictEqual(write.op.effect.range.basis.kind, "dynamic");

  if (
    read.op.effect.range.basis.kind === "dynamic" &&
    write.op.effect.range.basis.kind === "dynamic"
  ) {
    strictEqual(read.op.effect.range.basis.origin, access.origin);
    strictEqual(write.op.effect.range.basis.origin, access.origin);
  }

  deepStrictEqual(read.op.effect.range.slice, {
    byteOffset: 0,
    byteLength: 2
  });
  deepStrictEqual(write.op.effect.range.slice, {
    byteOffset: 4,
    byteLength: 4
  });
});

test("the Memory access builder gives constant instruction fetches absolute ranges", () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const memory = new MemoryAccessBuilder({
    values,
    currentBody: () => body
  });
  const access = memory.resolve(
    { start: values.const(0x2000), byteLength: values.const(4) },
    "instructionFetch"
  );

  memory.read(access, values.const(2), 16, { signed: true });

  const read = resourceActions(body, "resource.read")[0];

  ok(read !== undefined);
  deepStrictEqual(read.op.effect.range, {
    basis: { kind: "resource" },
    slice: { byteOffset: 0x2002, byteLength: 2 }
  });
  strictEqual(read.op.displacement, 2);
  strictEqual(read.op.signed, true);
  deepStrictEqual(access.fault, {
    address: access.range.start,
    intent: "instructionFetch"
  });
});

function resourceActions<Kind extends Operation["kind"]>(
  body: RegionBuilder,
  kind: Kind
): readonly ResourceAction<Kind>[] {
  return body.build().actions.filter(
    (action): action is ResourceAction<Kind> =>
      action.kind === "op" && action.op.kind === kind
  );
}
