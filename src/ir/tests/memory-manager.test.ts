import { ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { DynamicByteOriginRef } from "#compiler/ir/resource.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import {
  createIrBlockBuilder,
  staticInstructionLocation
} from "#ir/builder.js";
import type { OpAction } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { guestMemoryResource } from "#memory/flat.js";

type OperationOf<Kind extends Operation["kind"]> = Extract<Operation, { kind: Kind }>;
type ResourceAction<Kind extends Operation["kind"]> = OpAction & Readonly<{
  op: OperationOf<Kind>;
}>;

function resourceActions<Kind extends Operation["kind"]>(
  block: IrBlock,
  kind: Kind
): readonly ResourceAction<Kind>[] {
  return block.body.actions.filter(
    (action): action is ResourceAction<Kind> =>
      action.kind === "op" && action.op.kind === kind
  );
}

function build(template: SemanticTemplate): IrBlock {
  const builder = createIrBlockBuilder();

  builder.addInstruction(template, [], staticInstructionLocation(0x1000, 0x1001));
  return builder.finish();
}

test("MemoryManager expands a static resolution into one flat limit compare", () => {
  let invalid: ValueId | undefined;
  const block = build((s, v) => {
    invalid = s.memoryResolve(
      s.mem("ds", s.get(s.reg("eax"))),
      v.const(4),
      "read"
    ).invalid;
  });

  ok(invalid !== undefined);
  const node = block.values.node(invalid);

  strictEqual(node.kind, "compare");
  if (node.kind === "compare") {
    strictEqual(node.operator, "gt_u");
  }
  strictEqual(resourceActions(block, "resource.read").length, 0);
  strictEqual(resourceActions(block, "resource.write").length, 0);
});

test("a dynamic WRITE-intent RMW keeps one origin on its read and write", () => {
  let issuedOrigin: DynamicByteOriginRef | undefined;
  const block = build((s, v) => {
    const access = s.memoryResolve(
      s.mem("ds", s.get(s.reg("eax"))),
      v.const(4),
      "write"
    );

    issuedOrigin = access.origin;
    const loaded = s.memoryRead(access, v.const(0), 32);

    s.memoryWrite(access, v.const(0), loaded, 32);
  });
  const reads = resourceActions(block, "resource.read");
  const writes = resourceActions(block, "resource.write");

  strictEqual(reads.length, 1);
  strictEqual(writes.length, 1);
  ok(issuedOrigin !== undefined);
  strictEqual(reads[0]?.op.effect.resource, guestMemoryResource);
  strictEqual(writes[0]?.op.effect.resource, guestMemoryResource);
  strictEqual(reads[0]?.op.effect.range.basis.kind, "dynamic");
  strictEqual(writes[0]?.op.effect.range.basis.kind, "dynamic");
  if (
    reads[0]?.op.effect.range.basis.kind === "dynamic" &&
    writes[0]?.op.effect.range.basis.kind === "dynamic"
  ) {
    strictEqual(reads[0].op.effect.range.basis.origin, issuedOrigin);
    strictEqual(writes[0].op.effect.range.basis.origin, issuedOrigin);
  }
  strictEqual(reads[0]?.op.effect.range.slice?.byteOffset, 0);
  strictEqual(reads[0]?.op.effect.range.slice?.byteLength, 4);
  strictEqual(writes[0]?.op.effect.range.slice?.byteOffset, 0);
  strictEqual(writes[0]?.op.effect.range.slice?.byteLength, 4);
});

test("constant starts produce absolute facts and dynamic offsets widen to the basis", () => {
  const absoluteBlock = build((s, v) => {
    const access = s.memoryResolve(
      s.mem("ds", v.const(0x2000)),
      v.const(8),
      "read"
    );

    s.memoryRead(access, v.const(4), 32);
  });
  const absoluteRead = resourceActions(absoluteBlock, "resource.read")[0];

  ok(absoluteRead !== undefined);
  strictEqual(absoluteRead.op.displacement, 4);
  strictEqual(absoluteRead.op.effect.range.basis.kind, "resource");
  strictEqual(absoluteRead.op.effect.range.slice?.byteOffset, 0x2004);
  strictEqual(absoluteRead.op.effect.range.slice?.byteLength, 4);

  let issuedOrigin: DynamicByteOriginRef | undefined;
  const dynamicBlock = build((s, v) => {
    const access = s.memoryResolve(
      s.mem("ds", s.get(s.reg("eax"))),
      v.const(8),
      "read"
    );

    issuedOrigin = access.origin;
    s.memoryRead(access, s.get(s.reg("ecx")), 32);
  });
  const dynamicRead = resourceActions(dynamicBlock, "resource.read")[0];

  ok(dynamicRead !== undefined);
  ok(issuedOrigin !== undefined);
  strictEqual(dynamicRead.op.displacement, 0);
  strictEqual(dynamicRead.op.effect.range.basis.kind, "dynamic");
  if (dynamicRead.op.effect.range.basis.kind === "dynamic") {
    strictEqual(dynamicRead.op.effect.range.basis.origin, issuedOrigin);
  }
  strictEqual(dynamicRead.op.effect.range.slice, undefined);
});

test("static resolution lengths retain the compatibility construction contract", () => {
  throws(
    () => build((s, v) => {
      s.memoryResolve(s.mem("ds", v.const(0x2000)), v.const(0), "read");
    }),
    /integer between 1 and 65536/
  );
  throws(
    () => build((s, v) => {
      s.memoryResolve(s.mem("ds", v.const(0x2000)), v.const(65537), "read");
    }),
    /integer between 1 and 65536/
  );

  build((s) => {
    s.memoryResolve(s.mem("ds", s.get(s.reg("eax"))), s.get(s.reg("ecx")), "read");
  });
});
