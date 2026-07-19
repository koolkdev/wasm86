import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import type { StorageAccess } from "#compiler/ir/effects.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ByteRange,
  type ResourceRef
} from "#compiler/ir/resource.js";
import { valueId } from "#compiler/ir/values/id.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionType } from "#compiler/program/function-type.js";
import { functionRef } from "#compiler/program/refs.js";
import { CellRef } from "#compiler/refs/cell.js";
import type { Action, OpAction } from "#ir/actions.js";
import { covers, effectsOf, mayAlias } from "#ir/aliasing.js";

const firstResource = resourceRef("test.aliasing.first");
const secondResource = resourceRef("test.aliasing.second");
const firstCell = new CellRef("i32");
const secondCell = new CellRef("i32");

function effect(resource: ResourceRef, range: ByteRange): StorageAccess {
  return { space: "resource", resource, range };
}

function absolute(byteOffset: number, byteLength: number): ByteRange {
  return {
    basis: { kind: "resource" },
    slice: { byteOffset, byteLength }
  };
}

function readAction(range: ByteRange, output = 1): OpAction {
  return {
    kind: "op",
    output: valueId(output),
    op: resourceRead.create({
      source: {
        effect: { space: "resource", resource: firstResource, range },
        address: { base: valueId(0), displacement: 0 },
        width: 8
      }
    })
  };
}

function writeAction(range: ByteRange, value = 1): OpAction {
  return {
    kind: "op",
    op: resourceWrite.create({
      destination: {
        effect: { space: "resource", resource: firstResource, range },
        address: { base: valueId(0), displacement: 0 },
        width: 8
      },
      value: valueId(value)
    })
  };
}

test("effects derive from generic operations and nested control", () => {
  const first = absolute(0, 1);
  const second = absolute(4, 1);
  const action: Action = {
    kind: "if",
    condition: valueId(0),
    thenBody: { actions: [readAction(first), writeAction(second)] },
    elseBody: { actions: [writeAction(first)] }
  };

  deepStrictEqual(effectsOf(action), {
    reads: [effect(firstResource, first)],
    writes: [effect(firstResource, second), effect(firstResource, first)]
  });
});

test("control flow and finishes touch no data directly", () => {
  const values = new ValueTable();

  deepStrictEqual(
    effectsOf({
      kind: "if",
      condition: valueId(0),
      thenBody: { actions: [] },
      elseBody: { actions: [] }
    }),
    { reads: [], writes: [] }
  );
  deepStrictEqual(
    effectsOf({ kind: "finish", finish: { kind: "exit", result: values.const64(0n) } }),
    { reads: [], writes: [] }
  );
  deepStrictEqual(
    effectsOf({ kind: "finish", finish: { kind: "dispatch", targetEip: valueId(0) } }),
    { reads: [], writes: [] }
  );
});

test("direct-call effects come from their function definition", () => {
  const read = effect(firstResource, absolute(0, 4));
  const write = effect(firstResource, absolute(8, 4));
  const effects = { reads: [read], writes: [write] } as const;
  const target = new FunctionDefinition({
    ref: functionRef("test.aliasing-call"),
    type: functionType([], []),
    effects,
    owner: undefined,
    build: () => {}
  });

  deepStrictEqual(
    effectsOf({ kind: "call", target, arguments: [], outputs: [] }),
    effects
  );
  deepStrictEqual(
    effectsOf({ kind: "returnCall", target, arguments: [] }),
    effects
  );
});

test("cell identities alias only themselves and never resources", () => {
  const first: StorageAccess = { space: "cell", cell: firstCell };
  const second: StorageAccess = { space: "cell", cell: secondCell };
  const bytes = effect(firstResource, { basis: { kind: "resource" } });

  strictEqual(mayAlias(first, first), true);
  strictEqual(mayAlias(first, second), false);
  strictEqual(mayAlias(first, bytes), false);
  strictEqual(mayAlias(bytes, first), false);
  strictEqual(covers(first, first), true);
  strictEqual(covers(first, second), false);
});

test("absolute resource slices use interval overlap and containment", () => {
  const whole = effect(firstResource, { basis: { kind: "resource" } });
  const outer = effect(firstResource, absolute(4, 8));
  const inner = effect(firstResource, absolute(6, 2));
  const touching = effect(firstResource, absolute(12, 2));
  const foreign = effect(secondResource, absolute(6, 2));

  strictEqual(mayAlias(outer, inner), true);
  strictEqual(mayAlias(inner, outer), true);
  strictEqual(mayAlias(outer, touching), false);
  strictEqual(mayAlias(outer, foreign), false);
  strictEqual(covers(outer, inner), true);
  strictEqual(covers(inner, outer), false);
  strictEqual(covers(whole, outer), true);
  strictEqual(covers(outer, whole), false);
});

test("dynamic bases compare exactly when shared and conservatively otherwise", () => {
  const origin = new DynamicByteOriginRef();
  const otherOrigin = new DynamicByteOriginRef();
  const first = effect(firstResource, {
    basis: { kind: "dynamic", origin },
    slice: { byteOffset: 0, byteLength: 4 }
  });
  const disjoint = effect(firstResource, {
    basis: { kind: "dynamic", origin },
    slice: { byteOffset: 8, byteLength: 4 }
  });
  const unknown = effect(firstResource, {
    basis: { kind: "dynamic", origin: otherOrigin },
    slice: { byteOffset: 8, byteLength: 4 }
  });

  strictEqual(mayAlias(first, disjoint), false);
  strictEqual(mayAlias(first, unknown), true);
  strictEqual(covers(first, disjoint), false);
  strictEqual(covers(first, unknown), false);
});
