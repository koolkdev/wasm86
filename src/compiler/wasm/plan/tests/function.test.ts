import { ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { buildFunction } from "#compiler/function/builder/function.js";
import { Integer, functionType } from "#compiler/function/type.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import { functionRef } from "#compiler/reference.js";
import { noStorageEffects } from "#compiler/function/storage.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "../function.js";

const functionTypeUnderTest = functionType([Integer[32]], [Integer[32]]);
const targetType = functionType([Integer[32], Integer[32]], [Integer[32]]);
const target: CallTarget<typeof targetType> = {
  kind: "direct",
  ref: functionRef("wasm.plan.function.repeated-use"),
  type: targetType,
  effects: noStorageEffects
};

test("planning a Wasm body produces a typed emission schedule", () => {
  const body = lowerWasmFunction(
    buildFunction(functionTypeUnderTest, (fn) => {
      const [parameter] = fn.parameters;

      fn.returnCall(target, [parameter.add(1), parameter.add(1)]);
    })
  );
  const schedule = planWasmFunction(body).schedule;
  const evaluation = schedule.evaluations.find(
    (candidate) => candidate.kind === "atUse" && candidate.uses.length === 2
  );

  ok(evaluation?.local !== undefined);
  strictEqual(schedule.localTypes[evaluation.local], "i32");
});
