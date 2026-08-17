import { notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import type { VariableRef } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Float, Integer, i32 } from "#compiler/function/values.js";
import {
  siteId,
  type BodyEvent,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { resourceRef } from "#compiler/reference.js";
import { allocateWasmLocals } from "../locals.js";
import { placeEvaluations } from "../placement.js";

const resource = resourceRef("test.wasm-plan.locals");
const voidType = functionType([], []);

test("a variable remains live until a delayed read evaluation executes", () => {
  let first: VariableRef<(typeof Integer)[32]> | undefined;
  let second: VariableRef<(typeof Integer)[32]> | undefined;
  const body = lowerWasmFunction(
    buildFunction(voidType, (fn) => {
      first = fn.region.variable(i32(1));
      const snapshot = fn.region.read(first);

      second = fn.region.variable(i32(2));
      fn.region.writeResource(access(0), snapshot);
      fn.return([]);
    })
  );
  const placement = placeEvaluations(body);
  const readSite = eventSite(body, (event) => event.kind === "variableRead");
  const storeSite = eventSite(body, (event) => event.kind === "store");
  const read = placement.evaluations.find((evaluation) => evaluation.operationSite === readSite);

  ok(first !== undefined && second !== undefined);
  strictEqual(read?.anchor, storeSite);
  const locals = allocateWasmLocals(body, placement);
  const firstLocal = locals.variableLocals.get(first);
  const secondLocal = locals.variableLocals.get(second);

  ok(firstLocal !== undefined && secondLocal !== undefined);
  notStrictEqual(firstLocal, secondLocal);
});

test("float variables and loop inputs retain their Wasm local types", () => {
  let single: VariableRef<(typeof Float)[32]> | undefined;
  let double: VariableRef<(typeof Float)[64]> | undefined;
  const body = lowerWasmFunction(
    buildFunction(functionType([Float[32], Float[64]], []), (fn) => {
      const [singleSeed, doubleSeed] = fn.parameters;

      single = fn.region.variable(singleSeed);
      double = fn.region.variable(doubleSeed);
      fn.region.loop([singleSeed, doubleSeed], (loop, [singleInput, doubleInput]) => {
        loop.write(single!, singleInput);
        loop.write(double!, doubleInput);
        loop.loopContinue([singleInput, doubleInput]);
      });
      fn.return([]);
    })
  );
  const placement = placeEvaluations(body);
  const locals = allocateWasmLocals(body, placement);
  const loop = onlyEvent(body, "loop");
  const singleInput = loop.inputs[0];
  const doubleInput = loop.inputs[1];

  ok(single !== undefined && double !== undefined);
  ok(singleInput !== undefined && doubleInput !== undefined);
  const singleVariableLocal = locals.variableLocals.get(single);
  const doubleVariableLocal = locals.variableLocals.get(double);
  const singleInputLocal = locals.loopInputLocals[singleInput];
  const doubleInputLocal = locals.loopInputLocals[doubleInput];

  ok(singleVariableLocal !== undefined && doubleVariableLocal !== undefined);
  ok(singleInputLocal !== undefined && doubleInputLocal !== undefined);
  strictEqual(locals.localTypes[singleVariableLocal], "f32");
  strictEqual(locals.localTypes[doubleVariableLocal], "f64");
  strictEqual(locals.localTypes[singleInputLocal], "f32");
  strictEqual(locals.localTypes[doubleInputLocal], "f64");
});

test("disjoint compatible variables share one local", () => {
  let first: VariableRef<(typeof Integer)[32]> | undefined;
  let second: VariableRef<(typeof Integer)[32]> | undefined;
  const body = lowerWasmFunction(
    buildFunction(voidType, (fn) => {
      first = fn.region.variable(i32(1));
      fn.region.writeResource(access(0), fn.region.read(first));
      second = fn.region.variable(i32(2));
      fn.region.writeResource(access(1), fn.region.read(second));
      fn.return([]);
    })
  );
  const locals = allocateWasmLocals(body, placeEvaluations(body));

  ok(first !== undefined && second !== undefined);
  const firstLocal = locals.variableLocals.get(first);
  const secondLocal = locals.variableLocals.get(second);

  ok(firstLocal !== undefined && secondLocal !== undefined);
  strictEqual(firstLocal, secondLocal);
  strictEqual(locals.localTypes[firstLocal], "i32");
  strictEqual(locals.localTypes.length, 1);
});

test("variables reuse expired evaluation locals from the shared pool", () => {
  let variable: VariableRef<(typeof Integer)[32]> | undefined;
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
  const placement = placeEvaluations(body);
  const locals = allocateWasmLocals(body, placement);
  const snapshot = placement.evaluations.find((evaluation) => {
    const operation = evaluation.operationSite;

    return operation !== undefined && body.sites[operation]?.event.kind === "load";
  });

  ok(variable !== undefined && snapshot !== undefined);
  const snapshotIndex = placement.evaluations.indexOf(snapshot);
  const snapshotLocal = locals.evaluationLocals[snapshotIndex];

  ok(snapshotLocal !== undefined);
  strictEqual(locals.variableLocals.get(variable), snapshotLocal);
});

test("a loop-crossing variable remains live through the loop body", () => {
  let outer: VariableRef<(typeof Integer)[32]> | undefined;
  let inner: VariableRef<(typeof Integer)[32]> | undefined;
  const body = lowerWasmFunction(
    buildFunction(voidType, (fn) => {
      outer = fn.region.variable(i32(1));
      fn.region.loop([], (loop) => {
        loop.writeResource(access(0), loop.read(outer!));
        inner = loop.variable(i32(2));
        loop.writeResource(access(1), loop.read(inner));
        loop.loopContinue([]);
      });
      fn.return([]);
    })
  );
  const locals = allocateWasmLocals(body, placeEvaluations(body));

  ok(outer !== undefined && inner !== undefined);
  const outerLocal = locals.variableLocals.get(outer);
  const innerLocal = locals.variableLocals.get(inner);

  ok(outerLocal !== undefined && innerLocal !== undefined);
  notStrictEqual(outerLocal, innerLocal);
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

function eventSite(body: WasmBody, matches: (event: BodyEvent) => boolean): SiteId {
  const found = body.sites.flatMap((site, raw) => (matches(site.event) ? [siteId(raw)] : []));

  strictEqual(found.length, 1, "expected one matching body event");
  return found[0] as SiteId;
}

function onlyEvent<Kind extends BodyEvent["kind"]>(
  body: WasmBody,
  kind: Kind
): Extract<BodyEvent, { kind: Kind }> {
  const events = body.sites
    .map(({ event }) => event)
    .filter((event): event is Extract<BodyEvent, { kind: Kind }> => event.kind === kind);

  strictEqual(events.length, 1, `expected one ${kind} event`);
  return events[0] as Extract<BodyEvent, { kind: Kind }>;
}
