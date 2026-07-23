import { strictEqual } from "node:assert";
import { test } from "node:test";

import {
  DynamicByteOriginRef,
  resourceRef,
  type ByteRange,
  type ResourceEffect,
  type ResourceRef
} from "#compiler/ir/resource.js";
import { covers, mayAlias } from "#compiler/ir/effects.js";

const firstResource = resourceRef("test.range.first-resource");
const secondResource = resourceRef("test.range.second-resource");

function bytes(
  range: ByteRange,
  resource: ResourceRef = firstResource
): ResourceEffect {
  return { space: "resource", resource, range };
}

function absolute(start: number, byteLength: number): ByteRange {
  return {
    basis: { kind: "resource" },
    slice: { byteOffset: start, byteLength }
  };
}

function whole(origin: DynamicByteOriginRef): ByteRange {
  return { basis: { kind: "dynamic", origin } };
}

function slice(
  origin: DynamicByteOriginRef,
  byteOffset: number,
  byteLength: number
): ByteRange {
  return {
    basis: { kind: "dynamic", origin },
    slice: { byteOffset, byteLength }
  };
}

test("absolute byte ranges use half-open overlap", () => {
  const first = bytes(absolute(0x10, 4));
  const overlapping = bytes(absolute(0x13, 2));
  const adjacent = bytes(absolute(0x14, 4));

  strictEqual(mayAlias(first, overlapping), true);
  strictEqual(mayAlias(overlapping, first), true);
  strictEqual(mayAlias(first, adjacent), false);
  strictEqual(mayAlias(adjacent, first), false);
});

test("all bytes alias and cover every byte range", () => {
  const all = bytes({ basis: { kind: "resource" } });
  const exact = bytes(absolute(0x20, 4));
  const origin = new DynamicByteOriginRef();
  const dynamic = bytes(whole(origin));

  strictEqual(mayAlias(all, exact), true);
  strictEqual(mayAlias(exact, all), true);
  strictEqual(mayAlias(all, dynamic), true);
  strictEqual(covers(all, exact), true);
  strictEqual(covers(all, dynamic), true);
  strictEqual(covers(exact, all), false);
});

test("absolute range coverage uses half-open containment", () => {
  const outer = bytes(absolute(0x20, 8));
  const equal = bytes(absolute(0x20, 8));
  const inner = bytes(absolute(0x22, 3));
  const crossing = bytes(absolute(0x26, 3));

  strictEqual(covers(outer, equal), true);
  strictEqual(covers(outer, inner), true);
  strictEqual(covers(inner, outer), false);
  strictEqual(covers(outer, crossing), false);
});

test("same-origin whole bases and slices preserve relative precision", () => {
  const origin = new DynamicByteOriginRef();
  const access = bytes(whole(origin));
  const first = bytes(slice(origin, 0, 4));
  const overlapping = bytes(slice(origin, 3, 2));
  const adjacent = bytes(slice(origin, 4, 4));

  strictEqual(mayAlias(access, first), true);
  strictEqual(mayAlias(first, access), true);
  strictEqual(mayAlias(first, overlapping), true);
  strictEqual(mayAlias(first, adjacent), false);
  strictEqual(mayAlias(adjacent, first), false);
  strictEqual(covers(access, first), true);
  strictEqual(covers(access, access), true);
  strictEqual(covers(first, access), false);
  strictEqual(covers(bytes(slice(origin, 0, 8)), adjacent), true);
});

test("different dynamic origins conservatively may alias but never cover", () => {
  const firstOrigin = new DynamicByteOriginRef();
  const secondOrigin = new DynamicByteOriginRef();
  const first = bytes(slice(firstOrigin, 0, 1));
  const second = bytes(slice(secondOrigin, 8, 1));

  strictEqual(mayAlias(first, second), true);
  strictEqual(mayAlias(second, first), true);
  strictEqual(mayAlias(bytes(whole(firstOrigin)), bytes(whole(secondOrigin))), true);
  strictEqual(covers(bytes(whole(firstOrigin)), second), false);
  strictEqual(covers(first, second), false);
});

test("absolute and origin ranges conservatively may alias without covering", () => {
  const exact = bytes(absolute(0x100, 4));
  const dynamic = bytes(slice(new DynamicByteOriginRef(), 0, 4));

  strictEqual(mayAlias(exact, dynamic), true);
  strictEqual(mayAlias(dynamic, exact), true);
  strictEqual(covers(exact, dynamic), false);
  strictEqual(covers(dynamic, exact), false);
});

test("different resource identities never alias or cover", () => {
  const firstBytes = bytes({ basis: { kind: "resource" } }, firstResource);
  const secondBytes = bytes({ basis: { kind: "resource" } }, secondResource);

  strictEqual(mayAlias(firstBytes, secondBytes), false);
  strictEqual(covers(firstBytes, secondBytes), false);
});
