import { strictEqual } from "node:assert";
import { test } from "node:test";

import {
  type ByteRange,
  type DynamicByteOrigin,
  type ResourceEffect
} from "#compiler/function/resource.js";
import { covers, mayAlias, VariableRef } from "#compiler/function/storage.js";
import { Integer } from "#compiler/function/values.js";
import { resourceRef, type ResourceRef } from "#compiler/reference.js";

const firstResource = resourceRef("test.range.first-resource");
const secondResource = resourceRef("test.range.second-resource");

function resourceEffect(range: ByteRange, resource: ResourceRef = firstResource): ResourceEffect {
  return { kind: "resource", resource, range };
}

function wholeResourceRange(): ByteRange {
  return { kind: "whole", origin: "resource" };
}

function resourceSlice(byteOffset: number, byteLength: number): ByteRange {
  return { kind: "slice", origin: "resource", byteOffset, byteLength };
}

function wholeDynamicRange(origin: DynamicByteOrigin): ByteRange {
  return { kind: "whole", origin };
}

function dynamicSlice(
  origin: DynamicByteOrigin,
  byteOffset: number,
  byteLength: number
): ByteRange {
  return { kind: "slice", origin, byteOffset, byteLength };
}

test("variables alias and cover only their own identity", () => {
  const first = new VariableRef(Integer[32]);
  const second = new VariableRef(Integer[32]);

  strictEqual(mayAlias(first, first), true);
  strictEqual(covers(first, first), true);
  strictEqual(mayAlias(first, second), false);
  strictEqual(covers(first, second), false);
});

test("variables and resources are distinct storage spaces", () => {
  const variable = new VariableRef(Integer[32]);
  const resource = resourceEffect(wholeResourceRange());

  strictEqual(mayAlias(variable, resource), false);
  strictEqual(mayAlias(resource, variable), false);
  strictEqual(covers(variable, resource), false);
  strictEqual(covers(resource, variable), false);
});

test("different resources never alias or cover", () => {
  const first = resourceEffect(wholeResourceRange());
  const second = resourceEffect(wholeResourceRange(), secondResource);

  strictEqual(mayAlias(first, second), false);
  strictEqual(covers(first, second), false);
});

test("resource slices use half-open overlap and containment", () => {
  const outer = resourceEffect(resourceSlice(0x10, 8));
  const equal = resourceEffect(resourceSlice(0x10, 8));
  const inner = resourceEffect(resourceSlice(0x12, 3));
  const crossing = resourceEffect(resourceSlice(0x17, 2));
  const adjacent = resourceEffect(resourceSlice(0x18, 2));

  strictEqual(mayAlias(outer, crossing), true);
  strictEqual(mayAlias(crossing, outer), true);
  strictEqual(mayAlias(outer, adjacent), false);
  strictEqual(covers(outer, equal), true);
  strictEqual(covers(outer, inner), true);
  strictEqual(covers(inner, outer), false);
  strictEqual(covers(outer, crossing), false);
});

test("one dynamic origin preserves relative range precision", () => {
  const origin = Symbol();
  const whole = resourceEffect(wholeDynamicRange(origin));
  const first = resourceEffect(dynamicSlice(origin, 0, 4));
  const overlapping = resourceEffect(dynamicSlice(origin, 3, 2));
  const adjacent = resourceEffect(dynamicSlice(origin, 4, 4));

  strictEqual(mayAlias(first, overlapping), true);
  strictEqual(mayAlias(first, adjacent), false);
  strictEqual(covers(whole, first), true);
  strictEqual(covers(first, whole), false);
});

test("unrelated coordinate origins conservatively may alias without covering", () => {
  const first = resourceEffect(dynamicSlice(Symbol(), 0, 1));
  const second = resourceEffect(dynamicSlice(Symbol(), 8, 1));
  const absolute = resourceEffect(resourceSlice(0x100, 4));

  strictEqual(mayAlias(first, second), true);
  strictEqual(covers(first, second), false);
  strictEqual(covers(second, first), false);
  strictEqual(mayAlias(first, absolute), true);
  strictEqual(covers(first, absolute), false);
  strictEqual(covers(absolute, first), false);
});

test("the whole resource covers every coordinate origin", () => {
  const whole = resourceEffect(wholeResourceRange());
  const dynamic = resourceEffect(dynamicSlice(Symbol(), 0, 4));

  strictEqual(mayAlias(whole, dynamic), true);
  strictEqual(covers(whole, dynamic), true);
  strictEqual(covers(dynamic, whole), false);
});
