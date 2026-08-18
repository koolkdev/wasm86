import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import type { ResourceAccess, StorageWidth } from "#compiler/function/resource.js";
import { RegionBuilder } from "#compiler/function/builder/region.js";
import { i32, u8 } from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { flagStateFields } from "#core/flags/layout.js";
import { coreStateFields } from "#core/state/layout.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { BoundStateAccess, StateAccess } from "../access.js";

const cpuState = testExecutionModel.cpuState;

function createAccess(): Readonly<{
  body: RegionBuilder;
  access: BoundStateAccess;
}> {
  const body = new RegionBuilder(new ValueResolver());

  return {
    body,
    access: new StateAccess(cpuState).forRegion(body)
  };
}

test("static execution-state operands use exact absolute resource slices", () => {
  const { body, access } = createAccess();
  const gprs = cpuState.layout.namedArray(coreStateFields.gprs);
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
  strictEqual(body.constValue(eax.address.base), 0);
  strictEqual(eax.address.displacement, gprs.offset);
});

test("a folded dynamic GPR address becomes an exact static operand", () => {
  const { body, access } = createAccess();
  const gprs = cpuState.layout.namedArray(coreStateFields.gprs);
  const highEax = access.dynamicGpr(u8(4), 8);

  exactSlice(highEax, gprs.offset + 1, 1);
  strictEqual(body.constValue(highEax.address.base), 0);
});

test("an unresolved dynamic GPR operand covers only the GPR array", () => {
  const { body, access } = createAccess();
  const gprs = cpuState.layout.namedArray(coreStateFields.gprs);
  const index = access.read(access.gpr("al"));
  const operand = access.dynamicGpr(index, 8);

  exactSlice(operand, gprs.offset, gprs.stride * gprs.count);
  strictEqual(operand.address.displacement, gprs.offset);
  strictEqual(body.constValue(operand.address.base), undefined);
});

test("dynamic segment effects stay within the selected field array", () => {
  const { access } = createAccess();
  const bases = cpuState.layout.namedArray(coreStateFields.segmentBases);
  const index = access.read(access.gpr("al"));
  const operand = access.dynamicSegment(index, "base");

  exactSlice(operand, bases.offset, bases.stride * bases.count);
  strictEqual(operand.storageWidth, 32);
});

test("state reads and writes emit resource operations with their declared effects", () => {
  const { body, access } = createAccess();
  const flag = access.field(flagStateFields.concrete.ZF);
  const count = access.field(instructionCountField);

  access.read(flag);
  access.write(count, i32(7));

  const nodes = body.build().nodes;
  const reads = nodes.filter((node) => node.kind === "resource.read");
  const writes = nodes.filter((node) => node.kind === "resource.write");
  const read = reads[0];
  const write = writes[0];

  strictEqual(reads.length, 1);
  strictEqual(writes.length, 1);
  strictEqual(read?.source, flag);
  strictEqual(write?.destination, count);
  strictEqual(write?.destination.effect.resource, cpuState.resource);
});

function exactSlice<Width extends StorageWidth>(
  operand: ResourceAccess<Width>,
  byteOffset: number,
  byteLength: number
): void {
  strictEqual(operand.effect.resource, cpuState.resource);
  deepStrictEqual(operand.effect.range, {
    kind: "slice",
    origin: "resource",
    byteOffset,
    byteLength
  });
}
