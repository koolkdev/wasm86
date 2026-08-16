import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
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

test("if branches retain isolated bodies and one typed result", () => {
  const values = new ValueResolver();
  const builder = new RegionBuilder(values);
  const condition = values.parameter(0, Integer[1]);
  const whenTrue = values.parameter(1, Float[32]);
  const whenFalse = values.parameter(2, Float[32]);
  const variable = builder.variable(whenTrue);
  let thenResult!: Float<32>;
  let elseResult!: Float<32>;
  const joined = builder.ifValue(
    condition,
    (thenBody) => {
      thenBody.write(variable, whenTrue);
      thenResult = thenBody.read(variable);
      return thenResult;
    },
    (elseBody) => {
      elseBody.write(variable, whenFalse);
      elseResult = elseBody.read(variable);
      return elseResult;
    },
    { hint: "likely" }
  );

  builder.if(condition, (thenBody) => thenBody.write(variable, whenTrue), {
    hint: "unlikely",
    elseBuild: (elseBody) => elseBody.write(variable, whenFalse)
  });

  const region = builder.build();
  const valueBranch = region.nodes[1];
  const controlBranch = region.nodes[2];

  ok(valueBranch?.kind === "if");
  strictEqual(valueBranch.output, joined);
  strictEqual(valueBranch.hint, "likely");
  deepStrictEqual(
    valueBranch.thenBody.nodes.map((node) => node.kind),
    ["variable.write", "variable.read"]
  );
  deepStrictEqual(
    valueBranch.elseBody.nodes.map((node) => node.kind),
    ["variable.write", "variable.read"]
  );
  strictEqual(valueBranch.thenBody.result, thenResult);
  strictEqual(valueBranch.elseBody.result, elseResult);
  strictEqual(joined.kind, "float");
  strictEqual(joined.width, 32);

  ok(controlBranch?.kind === "if");
  strictEqual(controlBranch.output, undefined);
  strictEqual(controlBranch.hint, "unlikely");
  strictEqual(controlBranch.thenBody.nodes[0]?.kind, "variable.write");
  strictEqual(controlBranch.elseBody?.nodes[0]?.kind, "variable.write");
});

test("switch variants retain their cases, bodies, and typed result", () => {
  const values = new ValueResolver();
  const builder = new RegionBuilder(values);
  const selector = values.parameter(0, Integer[16]);
  const first = values.parameter(1, Float[64]);
  const second = values.parameter(2, Float[64]);
  const fallback = values.parameter(3, Float[64]);
  const variable = builder.variable(fallback);
  let firstResult!: Float<64>;
  const joined = builder.switch(
    selector,
    [
      {
        match: 3,
        build: (body) => {
          body.write(variable, first);
          firstResult = body.read(variable);
          return firstResult;
        }
      },
      { match: 7, build: () => second }
    ],
    () => fallback
  );

  builder.switchControl(
    selector,
    [
      {
        matches: [4, 8],
        build: (body) => body.write(variable, first)
      }
    ],
    (body) => body.write(variable, fallback)
  );

  const region = builder.build();
  const valueSwitch = region.nodes[1];
  const controlSwitch = region.nodes[2];

  ok(valueSwitch?.kind === "switch");
  strictEqual(valueSwitch.output, joined);
  deepStrictEqual(
    valueSwitch.cases.map((entry) => entry.matches),
    [[3], [7]]
  );
  strictEqual(valueSwitch.cases[0]?.body.nodes[0]?.kind, "variable.write");
  strictEqual(valueSwitch.cases[0]?.body.nodes[1]?.kind, "variable.read");
  strictEqual(valueSwitch.cases[0]?.body.result, firstResult);
  strictEqual(valueSwitch.cases[1]?.body.result, second);
  strictEqual(valueSwitch.defaultBody.result, fallback);
  strictEqual(joined.kind, "float");
  strictEqual(joined.width, 64);

  ok(controlSwitch?.kind === "switch");
  strictEqual(controlSwitch.output, undefined);
  deepStrictEqual(controlSwitch.cases[0]?.matches, [4, 8]);
  strictEqual(controlSwitch.cases[0]?.body.nodes[0]?.kind, "variable.write");
  strictEqual(controlSwitch.defaultBody.nodes[0]?.kind, "variable.write");
});

test("loops retain typed inputs and nested back edges", () => {
  const values = new ValueResolver();
  const builder = new RegionBuilder(values);
  const byteSeed = values.parameter(0, Integer[8]);
  const floatSeed = values.parameter(1, Float[64]);
  let byteInput!: Integer<8>;
  let floatInput!: Float<64>;

  builder.loop([byteSeed, floatSeed], (body, inputs) => {
    [byteInput, floatInput] = inputs;
    body.loop([byteInput], (inner, [innerInput]) => inner.loopContinue([innerInput]));
    body.if(byteInput.ne(0), (repeat) => repeat.loopContinue([byteInput, floatInput]));
    body.loopContinue([byteInput, floatInput]);
  });
  builder.loop([], (body) => body.loopContinue([]));

  const region = builder.build();
  const loop = region.nodes[0];
  const emptyLoop = region.nodes[1];

  ok(loop?.kind === "loop");
  strictEqual(loop.carried[0]?.seed, byteSeed);
  strictEqual(loop.carried[0]?.loopInput, byteInput);
  strictEqual(loop.carried[1]?.seed, floatSeed);
  strictEqual(loop.carried[1]?.loopInput, floatInput);
  notStrictEqual(byteInput, byteSeed);
  notStrictEqual(floatInput, floatSeed);
  strictEqual(byteInput.width, 8);
  strictEqual(floatInput.kind, "float");
  strictEqual(floatInput.width, 64);

  const innerLoop = loop.body.nodes[0];

  ok(innerLoop?.kind === "loop");
  const innerContinuation = innerLoop.body.nodes[0];

  ok(innerContinuation?.kind === "loopContinue");
  deepStrictEqual(innerContinuation.updates, [innerLoop.carried[0]?.loopInput]);

  const branch = loop.body.nodes[1];

  ok(branch?.kind === "if");
  const continuation = branch.thenBody.nodes[0];

  ok(continuation?.kind === "loopContinue");
  deepStrictEqual(continuation.updates, [byteInput, floatInput]);

  const outerContinuation = loop.body.nodes[2];

  ok(outerContinuation?.kind === "loopContinue");
  deepStrictEqual(outerContinuation.updates, [byteInput, floatInput]);

  ok(emptyLoop?.kind === "loop");
  deepStrictEqual(emptyLoop.carried, []);
  const emptyContinuation = emptyLoop.body.nodes[0];

  ok(emptyContinuation?.kind === "loopContinue");
  deepStrictEqual(emptyContinuation.updates, []);
});

test("build snapshots direct variable writes and ordinary fallthrough", () => {
  const values = new ValueResolver();
  const builder = new RegionBuilder(values);
  const empty = builder.build();
  const seed = values.parameter(0, Integer[32]);
  const variable = builder.variable(seed);
  const written = builder.build();

  builder.return([]);
  const returned = builder.build();

  strictEqual(empty.fallsThrough, true);
  strictEqual(empty.writtenVariables.size, 0);
  strictEqual(written.fallsThrough, true);
  strictEqual(written.writtenVariables.has(variable), true);
  strictEqual(returned.fallsThrough, false);
  strictEqual(returned.writtenVariables.has(variable), true);
});

test("regions include nested writes while loops conservatively fall through", () => {
  const values = new ValueResolver();
  const builder = new RegionBuilder(values);
  const seed = values.parameter(0, Integer[32]);
  const replacement = values.parameter(1, Integer[32]);
  const variable = builder.variable(seed);

  builder.loop([], (body) => {
    body.if(seed.eqz(), (arm) => arm.write(variable, replacement));
    body.loopContinue([]);
  });
  const region = builder.build();
  const loop = region.nodes.at(-1);

  ok(loop?.kind === "loop");
  strictEqual(loop.body.writtenVariables.has(variable), true);
  strictEqual(loop.body.fallsThrough, false);
  strictEqual(region.writtenVariables.has(variable), true);
  strictEqual(region.fallsThrough, true);
});
