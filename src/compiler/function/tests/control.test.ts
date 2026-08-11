import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { Control } from "#compiler/function/control.js";
import { Invocation } from "#compiler/function/invocation.js";
import type { Region } from "#compiler/function/region.js";
import { VariableRef } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Float, Integer } from "#compiler/function/values.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";
import { functionRef } from "#compiler/reference.js";

test("if and switch controls describe their selected regions", () => {
  const values = new ValueResolver();
  const condition = values.parameter(0, Integer[1]);
  const selector = values.parameter(1, Integer[32]);
  const thenResult = values.parameter(2, Float[32]);
  const elseResult = values.parameter(3, Float[32]);
  const output = values.producer(Float[32]);
  const thenBody: Region = { nodes: [], result: thenResult };
  const elseBody: Region = { nodes: [], result: elseResult };
  const ifDescription = Control.describe(Control.if({ condition, output, thenBody, elseBody }));
  const switchDescription = Control.describe(
    Control.switch({
      selector,
      output,
      cases: [{ matches: [4, 8], body: thenBody }],
      defaultBody: elseBody
    })
  );

  deepStrictEqual(ifDescription.operands, [condition]);
  strictEqual(ifDescription.output, output);
  deepStrictEqual(ifDescription.regions, [{ body: thenBody }, { body: elseBody }]);
  deepStrictEqual(ifDescription.effects, { reads: [], writes: [] });
  deepStrictEqual(switchDescription.operands, [selector]);
  strictEqual(switchDescription.output, output);
  deepStrictEqual(switchDescription.regions, [{ body: thenBody }, { body: elseBody }]);
});

test("loops describe their carried values and scoped body", () => {
  const values = new ValueResolver();
  const seed = values.parameter(0, Integer[16]);
  const loopInput = values.producer(Integer[16]);
  const update = values.parameter(1, Integer[16]);
  const continuation = Control.loopContinue({ updates: [update] });
  const body: Region = {
    nodes: [continuation]
  };
  const loopDescription = Control.describe(Control.loop({ carried: [{ seed, loopInput }], body }));
  const continueDescription = Control.describe(continuation);

  deepStrictEqual(loopDescription.operands, [seed]);
  deepStrictEqual(loopDescription.regions, [
    {
      body,
      loopInputs: [loopInput]
    }
  ]);
  deepStrictEqual(continueDescription.operands, [update]);
  strictEqual(continueDescription.output, undefined);
  deepStrictEqual(continueDescription.regions, []);
});

test("returned invocations expose their arguments and direct effects", () => {
  const values = new ValueResolver();
  const argument = values.parameter(0, Float[64]);
  const variable = new VariableRef(Integer[8]);
  const effects = { reads: [variable], writes: [] };
  const target = {
    kind: "direct" as const,
    ref: functionRef("test.control.return-target"),
    type: functionType([Float[64]], []),
    effects
  };
  const invocation = Invocation.create({ target, arguments: [argument] });
  const description = Control.describe(
    Control.return({ source: { kind: "invocation", invocation } })
  );

  deepStrictEqual(description.operands, [argument]);
  deepStrictEqual(description.effects, effects);
  strictEqual(description.output, undefined);
  deepStrictEqual(description.regions, []);
});
