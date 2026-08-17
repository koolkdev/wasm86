import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { noStorageEffects } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, type I32Value } from "#compiler/function/values.js";
import { functionRef, resourceRef, type ResourceRef } from "#compiler/reference.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "../function.js";

const unaryType = functionType([Integer[32]], [Integer[32]]);

test("dead pure operations create no function dependencies", () => {
  const memory = resourceRef("test.wasm-plan.function.dead-memory");
  const callType = functionType([], [Integer[32]]);
  const target: CallTarget<typeof callType> = {
    kind: "direct",
    ref: functionRef("test.wasm-plan.function.dead-call"),
    type: callType,
    effects: noStorageEffects
  };
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [address] = fn.parameters;

      fn.region.call(target, []);
      fn.region.readResource(access(memory, address, 0));
      fn.return([]);
    })
  );

  deepStrictEqual(planWasmFunction(body).dependencies, {
    directCalls: [],
    resources: []
  });
});

test("live dependencies retain first authored-site order without duplicates", () => {
  const firstMemory = resourceRef("test.wasm-plan.function.first-memory");
  const secondMemory = resourceRef("test.wasm-plan.function.second-memory");
  const first = target("test.wasm-plan.function.first-call");
  const second = target("test.wasm-plan.function.second-call");
  const tail = target("test.wasm-plan.function.tail-call");
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], [Integer[32]]), (fn) => {
      const [address, argument] = fn.parameters;
      const [firstResult] = fn.region.call(first, [argument]);
      const [repeatedResult] = fn.region.call(first, [argument]);
      const loaded = fn.region.readResource(access(firstMemory, address, 0));

      fn.region.writeResource(access(secondMemory, address, 4), loaded);
      const [secondResult] = fn.region.call(second, [argument]);

      fn.region.writeResource(access(firstMemory, address, 8), secondResult);
      fn.region.writeResource(access(secondMemory, address, 12), firstResult.add(repeatedResult));
      fn.returnCall(tail, [argument]);
    })
  );

  const { dependencies } = planWasmFunction(body);

  deepStrictEqual(dependencies, {
    directCalls: [first, second, tail],
    resources: [firstMemory, secondMemory]
  });
  strictEqual(dependencies.directCalls[0], first);
  strictEqual(dependencies.directCalls[1], second);
  strictEqual(dependencies.directCalls[2], tail);
});

test("a call retained for writes remains a dependency when its result is dead", () => {
  const memory = resourceRef("test.wasm-plan.function.call-effect");
  const effectful: CallTarget<typeof unaryType> = {
    ...target("test.wasm-plan.function.effectful-call"),
    effects: { reads: [], writes: [effect(memory, 0)] }
  };
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [argument] = fn.parameters;

      fn.region.call(effectful, [argument]);
      fn.return([]);
    })
  );

  const { dependencies } = planWasmFunction(body);

  deepStrictEqual(dependencies, {
    directCalls: [effectful],
    resources: []
  });
  strictEqual(dependencies.directCalls[0], effectful);
});

function target(id: string): CallTarget<typeof unaryType> {
  return {
    kind: "direct",
    ref: functionRef(id),
    type: unaryType,
    effects: noStorageEffects
  };
}

function access(resource: ResourceRef, base: I32Value, displacement: number): ResourceAccess<32> {
  return {
    effect: effect(resource, displacement),
    address: { base, displacement },
    storageWidth: 32,
    valueWidth: 32
  };
}

function effect(resource: ResourceRef, byteOffset: number): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: {
      kind: "slice",
      origin: "resource",
      byteOffset,
      byteLength: 4
    }
  };
}
