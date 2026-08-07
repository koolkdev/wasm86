import { deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { buildFunction } from "#compiler/function/builder/function.js";
import { Integer } from "#compiler/function/type.js";
import { functionType } from "#compiler/function/type.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess } from "#compiler/function/resource.js";
import { noStorageEffects } from "#compiler/function/storage.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import { resourceRef, type ResourceRef } from "#compiler/reference.js";
import type { I32Value } from "#compiler/function/values.js";
import { functionRef } from "#compiler/reference.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "../function.js";

const voidType = functionType([Integer[32]], []);
const directCallType = functionType([Integer[32]], [Integer[32]]);
const returningType = functionType([Integer[32], Integer[32], Integer[32]], [Integer[32]]);

test("dead pure calls and loads create no Wasm function dependencies", () => {
  const deadMemory = resourceRef("wasm.dependencies.dead-memory");
  const deadDirectType = functionType([], [Integer[32]]);
  const deadDirect: CallTarget<typeof deadDirectType> = {
    kind: "direct",
    ref: functionRef("wasm.dependencies.dead-direct"),
    type: deadDirectType,
    effects: noStorageEffects
  };
  const plan = planWasmFunction(
    lowerWasmFunction(
      buildFunction(voidType, (fn) => {
        const [base] = fn.parameters;

        fn.region.call(deadDirect, []);
        fn.region.readResource(memoryAccess(base, deadMemory));
        fn.return([]);
      })
    )
  );

  deepStrictEqual(plan.dependencies, { directCalls: [], resources: [] });
  deepStrictEqual(plan.requiredEffects, noStorageEffects);
});

test("live calls, tail calls, and memory operations retain ordered symbolic dependencies", () => {
  const firstMemory = resourceRef("wasm.dependencies.first-memory");
  const secondMemory = resourceRef("wasm.dependencies.second-memory");
  const direct = directTarget("wasm.dependencies.first-function");
  const second = directTarget("wasm.dependencies.second-function");
  const tail = directTarget("wasm.dependencies.tail-function");
  const secondTail = directTarget("wasm.dependencies.second-tail-function");
  const body = lowerWasmFunction(
    buildFunction(returningType, (fn) => {
      const [condition, base, argument] = fn.parameters;
      const [firstDirectResult] = fn.region.call(direct, [argument]);
      const [secondDirectResult] = fn.region.call(direct, [argument]);
      const loaded = fn.region.readResource(memoryAccess(base, firstMemory));

      fn.region.writeResource(memoryAccess(base, secondMemory), loaded);
      const [secondFunctionResult] = fn.region.call(second, [argument]);

      fn.region.writeResource(memoryAccess(base, firstMemory), secondFunctionResult);
      fn.region.writeResource(
        memoryAccess(base, secondMemory),
        firstDirectResult.add(secondDirectResult)
      );
      fn.region.if(condition.eqz(), (then) => then.returnCall(tail, [argument]), {
        elseBuild: (otherwise) => otherwise.returnCall(secondTail, [argument])
      });
    })
  );
  const { dependencies } = planWasmFunction(body);

  deepStrictEqual(dependencies.directCalls, [direct.ref, second.ref, tail.ref, secondTail.ref]);
  deepStrictEqual(dependencies.resources, [firstMemory, secondMemory]);
});

function directTarget(id: string): CallTarget<typeof directCallType> {
  return {
    kind: "direct",
    ref: functionRef(id),
    type: directCallType,
    effects: noStorageEffects
  };
}

function memoryAccess(base: I32Value, memory: ResourceRef): ResourceAccess<32> {
  return {
    effect: memoryEffect(memory),
    address: { base, displacement: 0 },
    width: 32,
    valueWidth: 32
  };
}

function memoryEffect(resource: ResourceRef): ResourceEffect {
  return {
    space: "resource",
    resource,
    range: { basis: { kind: "resource" } }
  };
}
