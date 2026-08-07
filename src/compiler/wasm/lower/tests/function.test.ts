import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { buildFunction } from "#compiler/function/builder/function.js";
import { Integer, functionType } from "#compiler/function/type.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess } from "#compiler/function/resource.js";
import { i32, nonzero, unreachable } from "#compiler/function/values.js";
import { functionRef } from "#compiler/reference.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import { resourceRef } from "#compiler/reference.js";
import type { VariableRef } from "#compiler/function/storage.js";
import {
  bodyEvent,
  eventOperands,
  siteId,
  type BodyEvent,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { wasmValueId, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { lowerWasmFunction } from "../function.js";

const resource = resourceRef("wasm.lower.function.test");

test("the body records control operands and nested effects", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;

      fn.region.if(nonzero(condition), (then) => {
        then.writeResource(access(1), i32(7));
      });
      fn.region.loop([i32(1)], (loop, [input]) => {
        loop.loopContinue([input.add(1)]);
      });
      fn.return([]);
    })
  );
  const branchSite = eventSite(body, (event) => event.kind === "if");
  const loopSite = eventSite(body, (event) => event.kind === "loop");
  const continueSite = eventSite(body, (event) => event.kind === "loopContinue");
  const store = eventSite(body, (event) => event.kind === "store");
  const branch = bodyEvent(body, branchSite);
  const loop = bodyEvent(body, loopSite);
  const continued = bodyEvent(body, continueSite);

  ok(branch.kind === "if");
  ok(loop.kind === "loop");
  ok(continued.kind === "loopContinue");
  deepStrictEqual(eventOperands(branch), [parameterValue(body, 0)]);
  strictEqual(loop.seeds.length, 1);
  strictEqual(loop.loopInputs.length, 1);
  strictEqual(continued.updates.length, 1);
  deepStrictEqual(body.operationSites, [store]);
  strictEqual(body.siteHasWrites[store], 1);
  deepStrictEqual(body.writeSites, [{ site: store, writes: [effect(1)] }]);
});

test("operation records retain their producer, operands, and direct effects", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [address] = fn.parameters;
      const loaded = fn.region.readResource(access(0, address));
      const sum = loaded.add(1);
      const dead = i32(40).add(2);

      fn.region.sameValue(dead, dead);
      fn.region.writeResource(access(1, address), sum);
      fn.region.writeResource(access(2, address), sum);
      fn.return([]);
    })
  );
  const loadSite = eventSite(body, (event) => event.kind === "load");
  const firstStore = eventSite(body, (event) => event.kind === "store" && event.displacement === 4);
  const secondStore = eventSite(
    body,
    (event) => event.kind === "store" && event.displacement === 8
  );
  const load = bodyEvent(body, loadSite);

  ok(load.kind === "load");
  strictEqual(body.producers[load.output], loadSite);
  deepStrictEqual(eventOperands(load), [parameterValue(body, 0)]);
  deepStrictEqual(body.siteReads[loadSite], [effect(0)]);
  strictEqual(body.siteHasWrites[loadSite], 0);
  strictEqual(bodyEvent(body, firstStore).kind, "store");
  strictEqual(body.siteHasWrites[firstStore], 1);
  strictEqual(body.siteHasWrites[secondStore], 1);
  ok(
    !wasmNodes(body).some(
      (node) => node.kind === "const" && node.type === "i32" && node.value === 42
    )
  );
});

test("an effectful result operation records effects when its output is unused", () => {
  const effects: StorageEffects = { reads: [effect(5)], writes: [effect(3)] };
  const target = effectfulTarget("wasm.lower.function.effectful-result", effects);
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [argument] = fn.parameters;

      fn.region.call(target, [argument]);
      fn.return([]);
    })
  );
  const callSite = eventSite(body, (event) => event.kind === "call");
  const call = bodyEvent(body, callSite);

  ok(call.kind === "call" && call.output !== undefined);
  strictEqual(body.producers[call.output], callSite);
  deepStrictEqual(eventOperands(call), [parameterValue(body, 0)]);
  deepStrictEqual(body.siteReads[callSite], effects.reads);
  strictEqual(body.siteHasWrites[callSite], 1);
  deepStrictEqual(body.writeSites, [{ site: callSite, writes: effects.writes }]);
});

test("variable operations record their direct read and write effects", () => {
  let variable: VariableRef<32> | undefined;
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], [Integer[32]]), (fn) => {
      const [initial] = fn.parameters;

      variable = fn.region.variable(initial);
      fn.return([fn.region.read(variable)]);
    })
  );

  ok(variable !== undefined);
  const writeSite = eventSite(body, (event) => event.kind === "variableWrite");
  const readSite = eventSite(body, (event) => event.kind === "variableRead");
  const write = bodyEvent(body, writeSite);
  const read = bodyEvent(body, readSite);
  const access = { space: "variable" as const, variable };

  ok(write.kind === "variableWrite");
  ok(read.kind === "variableRead");
  deepStrictEqual(eventOperands(write), [parameterValue(body, 0)]);
  deepStrictEqual(body.siteReads[writeSite], []);
  strictEqual(body.siteHasWrites[writeSite], 1);
  deepStrictEqual(body.writeSites, [{ site: writeSite, writes: [access] }]);
  deepStrictEqual(eventOperands(read), []);
  deepStrictEqual(body.siteReads[readSite], [access]);
  strictEqual(body.siteHasWrites[readSite], 0);
});

test("returned calls retain their operands and direct writes", () => {
  const effects: StorageEffects = { reads: [], writes: [effect(4)] };
  const target = effectfulTarget("wasm.lower.function.returned-call", effects);
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], [Integer[32]]), (fn) => {
      const [argument] = fn.parameters;

      fn.returnCall(target, [argument]);
    })
  );
  const returnSite = eventSite(body, (event) => event.kind === "returnCall");
  const returned = bodyEvent(body, returnSite);

  ok(returned.kind === "returnCall");
  deepStrictEqual(eventOperands(returned), [parameterValue(body, 0)]);
  strictEqual(body.siteHasWrites[returnSite], 1);
  deepStrictEqual(body.writeSites, [{ site: returnSite, writes: effects.writes }]);
});

test("join dependencies are retained independently of result liveness", () => {
  const dead = joinBody(false);
  const deadSite = eventSite(dead, (event) => event.kind === "if");
  const deadBranch = bodyEvent(dead, deadSite);

  ok(deadBranch.kind === "if" && deadBranch.output !== undefined);
  const deadDependencies = dead.joinDependencies[deadBranch.output];

  strictEqual(dead.joinProducers[deadBranch.output], deadSite);
  strictEqual(deadDependencies?.length, 2);
  const [thenDependency, elseDependency] = deadDependencies ?? [];
  const [thenArm, elseArm] = deadBranch.arms;

  ok(thenDependency !== undefined && elseDependency !== undefined);
  ok(thenArm !== undefined && elseArm !== undefined);
  strictEqual(thenDependency.consumedAt, dead.blocks[thenArm]?.closeSite);
  strictEqual(elseDependency.consumedAt, dead.blocks[elseArm]?.closeSite);
  const thenValue = dead.values.node(thenDependency.value);
  const elseValue = dead.values.node(elseDependency.value);

  ok(thenValue.kind === "const" && thenValue.type === "i32" && thenValue.value === 7);
  ok(elseValue.kind === "binary" && elseValue.operator === "add");
  ok(elseValue.inputs.some((input) => dead.values.node(input).kind === "unreachable"));
  ok(
    elseValue.inputs.some((input) => {
      const node = dead.values.node(input);

      return node.kind === "const" && node.type === "i32" && node.value === 1;
    })
  );

  const live = joinBody(true);
  const liveSite = eventSite(live, (event) => event.kind === "if");
  const liveBranch = bodyEvent(live, liveSite);

  ok(liveBranch.kind === "if" && liveBranch.output !== undefined);
  strictEqual(live.joinDependencies[liveBranch.output]?.length, 2);
});

function joinBody(used: boolean): WasmBody {
  return lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;
      const selected = fn.region.ifValue(
        nonzero(condition),
        () => i32(7),
        () => unreachable().add(1)
      );

      if (used) {
        fn.region.writeResource(access(6), selected);
      }
      fn.return([]);
    })
  );
}

function effectfulTarget(
  id: string,
  effects: StorageEffects
): CallTarget<ReturnType<typeof effectfulType>> {
  const type = effectfulType();

  return { kind: "direct", ref: functionRef(id), type, effects };
}

function effectfulType() {
  return functionType([Integer[32]], [Integer[32]]);
}

function access(region: number, base = i32(0)): ResourceAccess<32> {
  return {
    effect: effect(region),
    address: { base, displacement: region * 4 },
    width: 32,
    valueWidth: 32
  };
}

function effect(region: number): ResourceEffect {
  return {
    space: "resource",
    resource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: region * 4, byteLength: 4 }
    }
  };
}

function parameterValue(body: WasmBody, index: number): WasmValueId {
  return valueWhere(body, (node) => node.kind === "parameter" && node.index === index);
}

function eventSite(body: WasmBody, predicate: (event: BodyEvent) => boolean): SiteId {
  for (const [index, event] of body.events.entries()) {
    if (predicate(event)) {
      return siteId(index);
    }
  }
  throw new Error("expected Wasm body event");
}

function valueWhere(
  body: WasmBody,
  predicate: (node: ReturnType<WasmBody["values"]["node"]>) => boolean
): WasmValueId {
  for (let index = 0; index < body.values.length; index += 1) {
    const value = wasmValueId(index);

    if (predicate(body.values.node(value))) {
      return value;
    }
  }
  throw new Error("expected Wasm value");
}

function wasmNodes(body: WasmBody) {
  return Array.from({ length: body.values.length }, (_, index) =>
    body.values.node(wasmValueId(index))
  );
}
