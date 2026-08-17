import { notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import type { VariableRef } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, i32 } from "#compiler/function/values.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { resourceRef } from "#compiler/reference.js";
import { allocateWasmLocals } from "../locals.js";
import { placeEvaluations } from "../placement.js";

const resource = resourceRef("test.wasm-plan.locals-code-shape");

// Authored dead reads remain part of local code shape so eliminating one does
// not renumber otherwise-unrelated locals in the emitted function.
test("authored dead reads retain their baseline variable interval", () => {
  let first: VariableRef<(typeof Integer)[32]> | undefined;
  let second: VariableRef<(typeof Integer)[32]> | undefined;
  const body = lowerWasmFunction(
    buildFunction(functionType([], []), (fn) => {
      first = fn.region.variable(i32(1));
      second = fn.region.variable(i32(2));
      fn.region.read(first);
      fn.return([]);
    })
  );
  const placement = placeEvaluations(body);

  ok(first !== undefined && second !== undefined);
  strictEqual(
    placement.evaluations.some((evaluation) => {
      const operation = evaluation.operationSite;

      return operation !== undefined && body.sites[operation]?.event.kind === "variableRead";
    }),
    false
  );
  const locals = allocateWasmLocals(body, placement);
  const firstLocal = locals.variableLocals.get(first);
  const secondLocal = locals.variableLocals.get(second);

  ok(firstLocal !== undefined && secondLocal !== undefined);
  notStrictEqual(firstLocal, secondLocal);
});

// Local declaration order and every encoded local index depend on selecting
// the first compatible slot once multiple slots have expired.
test("allocation reuses the lowest compatible local", () => {
  let first: VariableRef<(typeof Integer)[32]> | undefined;
  let second: VariableRef<(typeof Integer)[32]> | undefined;
  let third: VariableRef<(typeof Integer)[32]> | undefined;
  const body = lowerWasmFunction(
    buildFunction(functionType([], []), (fn) => {
      first = fn.region.variable(i32(1));
      second = fn.region.variable(i32(2));
      fn.region.writeResource(access(0), fn.region.read(first));
      fn.region.writeResource(access(1), fn.region.read(second));
      third = fn.region.variable(i32(3));
      fn.return([]);
    })
  );
  const locals = allocateWasmLocals(body, placeEvaluations(body));

  ok(first !== undefined && second !== undefined && third !== undefined);
  strictEqual(locals.variableLocals.get(first), 0);
  strictEqual(locals.variableLocals.get(second), 1);
  strictEqual(locals.variableLocals.get(third), 0);
  strictEqual(locals.localTypes.length, 2);
});

function access(region: number): ResourceAccess<32> {
  return {
    effect: effect(region),
    address: { base: i32(0), displacement: region * 4 },
    storageWidth: 32,
    valueWidth: 32
  };
}

function effect(region: number): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: {
      kind: "slice",
      origin: "resource",
      byteOffset: region * 4,
      byteLength: 4
    }
  };
}
