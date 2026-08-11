import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { RegionBuilder } from "#compiler/function/builder/region.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { VariableRef } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Float, Integer } from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { functionRef, resourceRef } from "#compiler/reference.js";

test("straight-line storage operations retain their authored order and outputs", () => {
  const values = new ValueResolver();
  const builder = new RegionBuilder(values);
  const seed = values.parameter(0, Float[32]);
  const replacement = values.parameter(1, Float[32]);
  const variable = builder.variable(seed);
  const variableValue = builder.read(variable);

  builder.write(variable, replacement);

  const base = values.parameter(2, Integer[32]);
  const stored = values.parameter(3, Integer[8]);
  const effect: ResourceEffect = {
    kind: "resource",
    resource: resourceRef("test.region-builder.resource"),
    range: {
      kind: "slice",
      origin: "resource",
      byteOffset: 0,
      byteLength: 2
    }
  };
  const access: ResourceAccess<16, 8> = {
    effect,
    address: { base, displacement: 0 },
    storageWidth: 16,
    valueWidth: 8
  };
  const resourceValue = builder.readResource(access);

  builder.writeResource(access, stored);

  const region = builder.build();

  deepStrictEqual(
    region.nodes.map((node) => node.kind),
    ["variable.write", "variable.read", "variable.write", "resource.read", "resource.write"]
  );
  const variableRead = region.nodes[1];
  const resourceRead = region.nodes[3];

  ok(variableRead?.kind === "variable.read");
  ok(resourceRead?.kind === "resource.read");
  strictEqual(variableRead.output, variableValue);
  strictEqual(resourceRead.output, resourceValue);
  strictEqual(resourceValue.width, 8);
});

test("calls and returns retain their typed value linkage", () => {
  const values = new ValueResolver();
  const builder = new RegionBuilder(values);
  const argument = values.parameter(0, Integer[8]);
  const variable = new VariableRef(Float[64]);
  const effects = { reads: [variable], writes: [] };
  const valueTarget = {
    kind: "direct" as const,
    ref: functionRef("test.region-builder.value-call"),
    type: functionType([Integer[8]], [Float[64]]),
    effects
  };
  const resultlessTarget = {
    kind: "direct" as const,
    ref: functionRef("test.region-builder.resultless-call"),
    type: functionType([Float[64]], []),
    effects: { reads: [], writes: [] }
  };
  const [result] = builder.call(valueTarget, [argument]);

  builder.call(resultlessTarget, [result]);
  builder.return([result]);

  const region = builder.build();
  const valueCall = region.nodes[0];
  const resultlessCall = region.nodes[1];
  const returned = region.nodes[2];

  ok(valueCall?.kind === "call");
  ok(resultlessCall?.kind === "call");
  ok(returned?.kind === "return");
  strictEqual(valueCall.output, result);
  strictEqual(resultlessCall.output, undefined);
  ok(returned.source.kind === "values");
  deepStrictEqual(returned.source.values, [result]);

  const tailBuilder = new RegionBuilder(values);

  tailBuilder.returnCall(valueTarget, [argument]);

  const tailReturn = tailBuilder.build().nodes[0];

  ok(tailReturn?.kind === "return");
  ok(tailReturn.source.kind === "invocation");
  deepStrictEqual(tailReturn.source.invocation.arguments, [argument]);
  deepStrictEqual(tailReturn.source.invocation.target.effects, effects);
});
