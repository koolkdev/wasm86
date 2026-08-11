import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { Invocation } from "#compiler/function/invocation.js";
import { Operation } from "#compiler/function/operation.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { VariableRef } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Float, Integer } from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { functionRef, resourceRef } from "#compiler/reference.js";

test("resource operations expose their value and storage dependencies", () => {
  const values = new ValueResolver();
  const base = values.parameter(0, Integer[32]);
  const stored = values.parameter(1, Integer[16]);
  const output = values.producer(Integer[16]);
  const effect: ResourceEffect = {
    kind: "resource",
    resource: resourceRef("test.operation.resource"),
    range: {
      kind: "slice",
      origin: "resource",
      byteOffset: 0,
      byteLength: 2
    }
  };
  const access: ResourceAccess<16> = {
    effect,
    address: { base, displacement: 0 },
    storageWidth: 16,
    valueWidth: 16
  };
  const read = Operation.resourceRead(access, output);
  const write = Operation.resourceWrite(access, stored);
  const readDescription = Operation.describe(read);
  const writeDescription = Operation.describe(write);

  deepStrictEqual(readDescription.operands, [base]);
  strictEqual(readDescription.output, output);
  strictEqual(readDescription.resultType, Integer[16]);
  deepStrictEqual(readDescription.effects, { reads: [effect], writes: [] });
  deepStrictEqual(writeDescription.operands, [base, stored]);
  strictEqual(writeDescription.output, undefined);
  strictEqual(writeDescription.resultType, undefined);
  deepStrictEqual(writeDescription.effects, { reads: [], writes: [effect] });
});

test("variable and call operations retain their logical contracts", () => {
  const values = new ValueResolver();
  const variable = new VariableRef(Float[64]);
  const variableValue = values.parameter(0, Float[64]);
  const variableOutput = values.producer(Float[64]);
  const read = Operation.variableRead(variable, variableOutput);
  const write = Operation.variableWrite(variable, variableValue, "seed");
  const argument = values.parameter(1, Integer[32]);
  const effects = { reads: [variable], writes: [] };
  const target = {
    kind: "direct" as const,
    ref: functionRef("test.operation.call-target"),
    type: functionType([Integer[32]], [Integer[8]]),
    effects
  };
  const invocation = Invocation.create({ target, arguments: [argument] });
  const callOutput = values.producer(Integer[8]);
  const call = Operation.call(invocation, callOutput);
  const readDescription = Operation.describe(read);
  const writeDescription = Operation.describe(write);
  const callDescription = Operation.describe(call);

  deepStrictEqual(readDescription.operands, []);
  strictEqual(readDescription.output, variableOutput);
  strictEqual(readDescription.resultType, Float[64]);
  deepStrictEqual(readDescription.effects, { reads: [variable], writes: [] });
  deepStrictEqual(writeDescription.operands, [variableValue]);
  strictEqual(write.initialization, "seed");
  deepStrictEqual(writeDescription.effects, { reads: [], writes: [variable] });
  deepStrictEqual(callDescription.operands, [argument]);
  strictEqual(callDescription.output, callOutput);
  strictEqual(callDescription.resultType, Integer[8]);
  strictEqual(callDescription.effects, effects);
});

test("resultless calls have no produced value", () => {
  const target = {
    kind: "direct" as const,
    ref: functionRef("test.operation.effect-call"),
    type: functionType([], []),
    effects: { reads: [], writes: [] }
  };
  const call = Operation.call(Invocation.create({ target, arguments: [] }));
  const description = Operation.describe(call);

  deepStrictEqual(description.operands, []);
  strictEqual(description.output, undefined);
  strictEqual(description.resultType, undefined);
});
