import { ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { buildFunction } from "#compiler/function/builder/function.js";
import { functionType } from "#compiler/function/type.js";
import type { ResourceAccess } from "#compiler/function/resource.js";
import { i32, i64, u8 } from "#compiler/function/values.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import { resourceRef } from "#compiler/reference.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { WasmBody } from "#compiler/wasm/function/body.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { placeEvaluations, type WasmEvaluation } from "#compiler/wasm/plan/placement.js";
import { buildWasmSchedule, type WasmSchedule } from "#compiler/wasm/plan/schedule.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";

const resource = resourceRef("wasm.plan.locals");
const voidType = functionType([], []);

function buildSchedule(body: WasmBody): WasmSchedule {
  return buildWasmSchedule(body, placeEvaluations(body));
}

function defaultEvaluation(schedule: WasmSchedule, value: WasmValueId): WasmEvaluation | undefined {
  const id = schedule.defaultEvaluations[value];

  return id === undefined ? undefined : schedule.evaluations[id];
}

test("variable locals retain Wasm types in first-allocation order", () => {
  let narrow: VariableRef<8> | undefined;
  let wide: VariableRef<64> | undefined;
  const body = lowerWasmFunction(
    buildFunction(voidType, (fn) => {
      narrow = fn.region.variable(u8(1));
      wide = fn.region.variable(i64(2n));
      fn.return([]);
    })
  );
  const schedule = buildSchedule(body);

  ok(narrow !== undefined && wide !== undefined);
  const narrowLocal = schedule.variableLocals.get(narrow);
  const wideLocal = schedule.variableLocals.get(wide);

  strictEqual(narrowLocal, 0);
  strictEqual(wideLocal, 1);
  strictEqual(schedule.localTypes[0], "i32");
  strictEqual(schedule.localTypes[1], "i64");
});

test("disjoint variable lifetimes reuse the lowest compatible local", () => {
  let first: VariableRef<32> | undefined;
  let second: VariableRef<32> | undefined;
  const body = lowerWasmFunction(
    buildFunction(voidType, (fn) => {
      first = fn.region.variable(i32(1));
      fn.region.writeResource(access(0), fn.region.read(first));
      second = fn.region.variable(i32(2));
      fn.region.writeResource(access(1), fn.region.read(second));
      fn.return([]);
    })
  );
  const schedule = buildSchedule(body);

  ok(first !== undefined && second !== undefined);
  strictEqual(schedule.variableLocals.get(first), 0);
  strictEqual(schedule.variableLocals.get(second), 0);
  strictEqual(schedule.localTypes.length, 1);
});

test("a variable and an earlier value temporary share the same local pool", () => {
  let variable: VariableRef<32> | undefined;
  const body = lowerWasmFunction(
    buildFunction(voidType, (fn) => {
      const snapshot = fn.region.readResource(access(0));

      fn.region.writeResource(access(1), snapshot);
      fn.region.writeResource(access(2), snapshot);
      variable = fn.region.variable(i32(1));
      fn.region.writeResource(access(3), fn.region.read(variable));
      fn.return([]);
    })
  );
  const schedule = buildSchedule(body);
  const snapshotEvaluation = defaultEvaluation(schedule, loadOutput(body, 0));

  ok(variable !== undefined);
  const variableLocal = schedule.variableLocals.get(variable);

  ok(snapshotEvaluation?.local !== undefined);
  ok(variableLocal !== undefined);
  strictEqual(snapshotEvaluation.local, variableLocal);
});

test("a loop-crossing variable remains live through the whole loop", () => {
  let outer: VariableRef<32> | undefined;
  let inner: VariableRef<32> | undefined;
  const body = lowerWasmFunction(
    buildFunction(voidType, (fn) => {
      outer = fn.region.variable(i32(1));
      fn.region.loop([], (loop) => {
        loop.writeResource(access(0), loop.read(outer!));
        inner = loop.variable(i32(5));
        loop.writeResource(access(1), loop.read(inner));
        loop.loopContinue([]);
      });
      fn.return([]);
    })
  );
  const schedule = buildSchedule(body);

  ok(outer !== undefined && inner !== undefined);
  const outerLocal = schedule.variableLocals.get(outer);
  const innerLocal = schedule.variableLocals.get(inner);

  ok(outerLocal !== undefined);
  ok(innerLocal !== undefined);
  strictEqual(outerLocal === innerLocal, false);
});

test("freed value locals are reused from the lowest index", () => {
  const body = lowerWasmFunction(
    buildFunction(voidType, (fn) => {
      const first = fn.region.readResource(access(0));
      const second = fn.region.readResource(access(1));

      fn.region.writeResource(access(2), first);
      fn.region.writeResource(access(3), second);
      fn.region.writeResource(access(4), second);
      fn.region.writeResource(access(5), first);
      const third = fn.region.readResource(access(6));

      fn.region.writeResource(access(7), third);
      fn.region.writeResource(access(8), third);
      fn.return([]);
    })
  );
  const schedule = buildSchedule(body);
  const firstEvaluation = defaultEvaluation(schedule, loadOutput(body, 0));
  const secondEvaluation = defaultEvaluation(schedule, loadOutput(body, 1));
  const thirdEvaluation = defaultEvaluation(schedule, loadOutput(body, 6));

  ok(firstEvaluation?.local !== undefined);
  ok(secondEvaluation?.local !== undefined);
  ok(thirdEvaluation?.local !== undefined);
  strictEqual(firstEvaluation.local, 0);
  strictEqual(secondEvaluation.local, 1);
  strictEqual(thirdEvaluation.local, 0);
  strictEqual(schedule.localTypes.length, 2);
});

function access(region: number): ResourceAccess<32> {
  return {
    effect: effect(region),
    address: { base: i32(0), displacement: region * 4 },
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

function loadOutput(body: WasmBody, region: number): WasmValueId {
  for (const event of body.events) {
    if (event.kind === "load" && event.displacement === region * 4) {
      return event.output;
    }
  }
  throw new Error(`expected load for region ${region}`);
}
