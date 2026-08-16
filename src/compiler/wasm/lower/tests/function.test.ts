import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { functionType } from "#compiler/function/type.js";
import { Float, Integer, f64, nonzero } from "#compiler/function/values.js";
import type { BlockId, BodyEvent, WasmBody } from "#compiler/wasm/function/body.js";
import { functionRef, resourceRef } from "#compiler/reference.js";
import { lowerWasmFunction } from "../function.js";

const resource = resourceRef("test.wasm-lower-function.resource");

test("operations retain their Wasm operands, outputs, and storage contracts", () => {
  const callTarget: CallTarget<ReturnType<typeof callType>> = {
    kind: "direct",
    ref: functionRef("test.wasm-lower-function.call"),
    type: callType(),
    effects: { reads: [effect(0, 4)], writes: [] }
  };
  const tailTarget: CallTarget<ReturnType<typeof tailType>> = {
    kind: "direct",
    ref: functionRef("test.wasm-lower-function.tail-call"),
    type: tailType(),
    effects: { reads: [], writes: [] }
  };
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Float[32]], [Integer[8]]), (fn) => {
      const [address, initial] = fn.parameters;
      const variable = fn.region.variable(initial);
      const floating = fn.region.read(variable);
      const loaded = fn.region.readResource(access32(address));
      const [result] = fn.region.call(callTarget, [loaded, floating]);

      fn.region.writeResource(accessByteInWord(address), result);
      fn.returnCall(tailTarget, [result]);
    })
  );
  const load = onlyEvent(body, "load");
  const write = onlyEvent(body, "variableWrite");
  const read = onlyEvent(body, "variableRead");
  const call = onlyEvent(body, "call");
  const store = onlyEvent(body, "store");
  const returned = onlyEvent(body, "returnCall");

  strictEqual(load.storageWidth, 32);
  strictEqual(body.values.node(load.output).type, "i32");
  strictEqual(write.variable, read.variable);
  strictEqual(write.initialization, "seed");
  strictEqual(body.values.node(read.output).type, "f32");
  deepStrictEqual(call.operands, [load.output, read.output]);
  ok(call.output !== undefined);
  strictEqual(body.values.node(call.output).type, "i32");
  strictEqual(store.storageWidth, 32);
  strictEqual(store.value, call.output);
  strictEqual(returned.target, tailTarget);
  deepStrictEqual(returned.operands, [call.output]);
});

test("64-bit transfers bridge narrower logical values explicitly", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], [Integer[32]]), (fn) => {
      const [address] = fn.parameters;
      const loaded = fn.region.readResource(access32In64(address, 0));

      fn.region.writeResource(access32In64(address, 8), loaded);
      fn.return([loaded]);
    })
  );
  const load = onlyEvent(body, "load");
  const store = onlyEvent(body, "store");
  const returned = onlyEvent(body, "return");
  const logical = returned.operands[0];

  strictEqual(load.storageWidth, 64);
  strictEqual(body.values.node(load.output).type, "i64");
  ok(logical !== undefined);
  deepStrictEqual(body.values.node(logical), {
    kind: "convert",
    type: "i32",
    inputs: [load.output],
    operator: "wrap_i64"
  });
  strictEqual(store.storageWidth, 64);
  deepStrictEqual(body.values.node(store.value), {
    kind: "convert",
    type: "i64",
    inputs: [logical],
    operator: "extend_i32_u"
  });
});

test("branch events own their nested blocks and joined results", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[16]], [Float[64]]), (fn) => {
      const [condition, selector] = fn.parameters;
      const selected = fn.region.ifValue(
        nonzero(condition),
        () => f64(1),
        (otherwise) =>
          otherwise.switch(selector, [{ match: 4, build: () => f64(2) }], () => f64(3)),
        { hint: "likely" }
      );

      fn.return([selected]);
    })
  );
  const branch = onlyEvent(body, "if");
  const switched = onlyEvent(body, "switch");
  const returned = onlyEvent(body, "return");

  strictEqual(branch.hint, "likely");
  strictEqual(branch.arms.length, 2);
  for (const arm of branch.arms) {
    const end = onlyBlockEnd(body, arm);

    strictEqual(end.fallsThrough, true);
  }
  deepStrictEqual(switched.caseMatches, [[4]]);
  strictEqual(switched.arms.length, 2);
  for (const arm of switched.arms) {
    onlyBlockEnd(body, arm);
  }
  ok(branch.output !== undefined);
  ok(switched.output !== undefined);
  strictEqual(body.values.node(branch.output).type, "f64");
  strictEqual(body.values.node(switched.output).type, "f64");
  deepStrictEqual(returned.operands, [branch.output]);
});

test("a terminal branch records non-fallthrough blocks", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[1]], []), (fn) => {
      const [condition] = fn.parameters;

      fn.region.if(condition, (thenBody) => thenBody.return([]), {
        elseBuild: (elseBody) => elseBody.return([])
      });
    })
  );
  const branch = onlyEvent(body, "if");
  const entryEnd = onlyBlockEnd(body, body.entryBlock);

  strictEqual(entryEnd.fallsThrough, false);
  for (const arm of branch.arms) {
    const end = onlyBlockEnd(body, arm);

    strictEqual(end.fallsThrough, false);
    strictEqual(end.result, undefined);
  }
});

test("loops retain typed carried values and an explicit back edge", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[8], Float[64]], []), (fn) => {
      const [byte, floating] = fn.parameters;
      const variable = fn.region.variable(floating);

      fn.region.loop([byte, floating], (loop, [byteInput, floatInput]) => {
        loop.write(variable, floatInput.add(1));
        loop.loopContinue([byteInput, floatInput]);
      });
      fn.return([]);
    })
  );
  const loop = onlyEvent(body, "loop");
  const continued = onlyEvent(body, "loopContinue");
  const loopEnd = onlyBlockEnd(body, loop.body);

  strictEqual(loopEnd.fallsThrough, false);
  deepStrictEqual(
    loop.inputs.map((input) => body.values.node(input).type),
    ["i32", "f64"]
  );
  strictEqual(loop.seeds.length, 2);
  deepStrictEqual(continued.updates, loop.inputs);
  const entryEnd = onlyBlockEnd(body, body.entryBlock);

  strictEqual(entryEnd.fallsThrough, false);
});

function callType() {
  return functionType([Integer[32], Float[32]], [Integer[8]]);
}

function tailType() {
  return functionType([Integer[8]], [Integer[8]]);
}

function access32(base: Integer<32>): ResourceAccess<32> {
  return {
    effect: effect(0, 4),
    address: { base, displacement: 0 },
    storageWidth: 32,
    valueWidth: 32
  };
}

function accessByteInWord(base: Integer<32>): ResourceAccess<32, 8> {
  return {
    effect: effect(4, 4),
    address: { base, displacement: 4 },
    storageWidth: 32,
    valueWidth: 8
  };
}

function access32In64(base: Integer<32>, displacement: number): ResourceAccess<64, 32> {
  return {
    effect: effect(displacement, 8),
    address: { base, displacement },
    storageWidth: 64,
    valueWidth: 32
  };
}

function effect(byteOffset: number, byteLength: number): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "slice", origin: "resource", byteOffset, byteLength }
  };
}

function onlyEvent<Kind extends BodyEvent["kind"]>(
  body: WasmBody,
  kind: Kind
): Extract<BodyEvent, { kind: Kind }> {
  const matches = body.sites.flatMap((site) => (site.event.kind === kind ? [site.event] : []));

  strictEqual(matches.length, 1, `expected one ${kind} event`);
  return matches[0] as Extract<BodyEvent, { kind: Kind }>;
}

function onlyBlockEnd(body: WasmBody, block: BlockId): Extract<BodyEvent, { kind: "end" }> {
  const matches = body.sites.filter((site) => site.block === block && site.event.kind === "end");

  strictEqual(matches.length, 1, `expected one end for block ${block}`);
  const event = matches[0]?.event;

  ok(event?.kind === "end");
  return event;
}
