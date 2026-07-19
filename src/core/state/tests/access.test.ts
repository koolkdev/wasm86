import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { ResourceByteOperand } from "#compiler/ir/resource.js";
import { resourceRef } from "#compiler/ir/resource.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import { cpuState } from "#cpu/state.js";
import { flagStateFields } from "#core/flags/layout.js";
import { coreStateFields } from "#core/state/layout.js";
import { RegionBuilder } from "#ir/region-builder.js";
import {
  BoundStateAccess,
  StateAccess
} from "../access.js";

function createAccess(): Readonly<{
  values: ValueTable;
  body: RegionBuilder;
  access: BoundStateAccess;
}> {
  const values = new ValueTable();
  const body = new RegionBuilder(values);

  return {
    values,
    body,
    access: new StateAccess(cpuState).bind(body)
  };
}

test("static execution-state operands use exact absolute resource slices", () => {
  const { values, access } = createAccess();
  const gprs = cpuState.layout.array(coreStateFields.gprs);
  const eax = access.gpr("eax");
  const ax = access.gpr("ax");
  const al = access.gpr("al");
  const ah = access.gpr("ah");
  const ebx = access.gpr("ebx");

  exactSlice(eax, gprs.offset, 4);
  exactSlice(ax, gprs.offset, 2);
  exactSlice(al, gprs.offset, 1);
  exactSlice(ah, gprs.offset + 1, 1);
  exactSlice(ebx, gprs.offset + 3 * gprs.stride, 4);
  strictEqual(values.constValue(eax.address.base), 0);
  strictEqual(eax.address.displacement, gprs.offset);
});

test("a folded dynamic GPR address becomes an exact static operand", () => {
  const { values, access } = createAccess();
  const gprs = cpuState.layout.array(coreStateFields.gprs);
  const highEax = access.dynamicGpr(values.const(4), 8);

  exactSlice(highEax, gprs.offset + 1, 1);
  strictEqual(values.constValue(highEax.address.base), 0);
});

test("an unresolved dynamic GPR operand covers only the GPR array", () => {
  const { values, access } = createAccess();
  const gprs = cpuState.layout.array(coreStateFields.gprs);
  const operand = access.dynamicGpr(values.parameter(0, "i32"), 8);

  exactSlice(operand, gprs.offset, gprs.stride * gprs.count);
  strictEqual(operand.address.displacement, gprs.offset);
  strictEqual(values.node(operand.address.base).kind, "binary");
});

test("dynamic segment effects stay within the selected field array", () => {
  const { values, access } = createAccess();
  const bases = cpuState.layout.array(coreStateFields.segmentBases);
  const operand = access.dynamicSegment(values.parameter(0, "i32"), "base");

  exactSlice(operand, bases.offset, bases.stride * bases.count);
  strictEqual(operand.width, 32);
});

test("state reads and writes normalize to resource operations", () => {
  const { values, body, access } = createAccess();
  const flag = access.field(flagStateFields.concrete.ZF);
  const count = access.field(instructionCountField);
  const flagValue = access.readField(
    flagStateFields.concrete.ZF,
    { kind: "unsigned", bounds: fitsUnsigned(1) }
  );

  access.write(count, values.const(7));

  const actions = body.build().actions;
  const read = actions[0];
  const write = actions[1];

  strictEqual(read?.kind, "op");
  strictEqual(read.op.kind, "resource.read");
  strictEqual(read.output, flagValue);
  strictEqual(read.op.signed, undefined);
  strictEqual(read.op.result.type, "i32");
  deepStrictEqual(read.op.result.bounds, { unsignedBits: 1, signedBits: 2 });
  strictEqual(read.op.inputs[0]?.value, flag.address.base);
  strictEqual(write?.kind, "op");
  strictEqual(write.op.kind, "resource.write");
  strictEqual(write.op.effect.resource, cpuState.resource);
});

test("execution-state access rejects an operand from another resource", () => {
  const { access } = createAccess();
  const foreignResource = resourceRef("test.foreign");
  const foreign: ResourceByteOperand = {
    effect: {
      space: "resource",
      resource: foreignResource,
      range: {
        basis: { kind: "resource" },
        slice: { byteOffset: 0, byteLength: 4 }
      }
    },
    address: { base: 0 as ResourceByteOperand["address"]["base"], displacement: 0 },
    width: 32
  };

  throws(
    () => access.read(foreign),
    /operand belongs to another resource/
  );
});

test("execution-state access rejects meaningless 32-bit signedness", () => {
  const { access } = createAccess();

  throws(
    () => access.read(access.gpr("eax"), { kind: "signed" }),
    /32-bit state read has no signed extension/
  );
});

function exactSlice(
  operand: ResourceByteOperand,
  byteOffset: number,
  byteLength: number
): void {
  strictEqual(operand.effect.resource, cpuState.resource);
  deepStrictEqual(operand.effect.range, {
    basis: { kind: "resource" },
    slice: { byteOffset, byteLength }
  });
}
