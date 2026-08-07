import { ok, throws } from "node:assert";
import { test } from "node:test";
import { buildFunction } from "#compiler/function/builder/function.js";
import { Integer, functionType } from "#compiler/function/type.js";
import type { ResourceAccess } from "#compiler/function/resource.js";
import { i32, nonzero } from "#compiler/function/values.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import { resourceRef } from "#compiler/reference.js";
import type { VariableRef } from "#compiler/function/storage.js";
import {
  siteId,
  type BodyEvent,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "#compiler/wasm/plan/function.js";
import { validateWasmSchedule } from "#compiler/wasm/plan/validate.js";

const resource = resourceRef("wasm.plan.validate");

test("validation rejects an anchor that does not dominate a recorded use", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], []), (fn) => {
      const [condition, source] = fn.parameters;
      const shared = source.add(1);

      fn.region.if(nonzero(condition), (then) => then.writeResource(access(0), shared), {
        elseBuild: (otherwise) => otherwise.writeResource(access(1), shared)
      });
      fn.return([]);
    })
  );
  const schedule = planWasmFunction(body).schedule;
  const evaluation = schedule.evaluations.find((candidate) => candidate.kind === "capture");

  ok(evaluation !== undefined);
  const evaluations = [...schedule.evaluations];
  const id = evaluations.indexOf(evaluation);

  evaluations[id] = { ...evaluation, anchor: storeSite(body, 0) };
  throws(
    () => validateWasmSchedule(body, { ...schedule, evaluations }),
    /does not dominate its use/
  );
});

test("validation rejects overlapping variable lifetimes in one local", () => {
  let first: VariableRef<32> | undefined;
  let second: VariableRef<32> | undefined;
  const body = lowerWasmFunction(
    buildFunction(functionType([], []), (fn) => {
      first = fn.region.variable(i32(1));
      second = fn.region.variable(i32(2));
      const firstValue = fn.region.read(first);
      const secondValue = fn.region.read(second);

      fn.region.writeResource(access(0), firstValue);
      fn.region.writeResource(access(1), secondValue);
      fn.return([]);
    })
  );
  const schedule = planWasmFunction(body).schedule;

  ok(first !== undefined && second !== undefined);
  const firstLocal = schedule.variableLocals.get(first);
  const secondLocal = schedule.variableLocals.get(second);

  ok(firstLocal !== undefined);
  ok(secondLocal !== undefined);
  const variableLocals = new Map(schedule.variableLocals);

  variableLocals.set(second, firstLocal);
  throws(
    () => validateWasmSchedule(body, { ...schedule, variableLocals }),
    /is claimed .* while live through/
  );
});

test("validation rejects a capture the emitter cannot evaluate at its deadline", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32], Integer[32]], []), (fn) => {
      const [condition, dividend, divisor] = fn.parameters;
      const quotient = dividend.signed.div(divisor);

      fn.region.if(nonzero(condition), (then) => {
        then.writeResource(access(0), quotient);
      });
      fn.return([]);
    })
  );
  const schedule = planWasmFunction(body).schedule;
  const evaluation = schedule.evaluations.find((candidate) => candidate.kind === "atUse");

  ok(evaluation !== undefined);
  const evaluations = [...schedule.evaluations];
  const id = evaluations.indexOf(evaluation);

  evaluations[id] = {
    ...evaluation,
    kind: "capture",
    anchor: entryEventSite(body, "if")
  };
  throws(() => validateWasmSchedule(body, { ...schedule, evaluations }), /cannot speculate/);
});

test("validation rejects two fusions claiming one evaluation", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([], []), (fn) => {
      const first = fn.region.readResource(byteAccess(0)).signed.extend(32);

      fn.region.writeResource(access(1), first);
      const second = fn.region.readResource(byteAccess(2)).signed.extend(32);

      fn.region.writeResource(access(3), second);
      fn.return([]);
    })
  );
  const schedule = planWasmFunction(body).schedule;
  const fused = schedule.evaluations.filter((evaluation) => evaluation.fusion !== undefined);
  const first = fused[0];
  const second = fused[1];

  ok(first?.fusion !== undefined && second?.fusion !== undefined);
  const evaluations = [...schedule.evaluations];
  const secondId = evaluations.indexOf(second);

  evaluations[secondId] = { ...second, fusion: first.fusion };
  throws(() => validateWasmSchedule(body, { ...schedule, evaluations }), /is fused more than once/);
});

function access(region: number): ResourceAccess<32> {
  return {
    effect: effect(region, 4),
    address: { base: i32(0), displacement: region * 4 },
    width: 32,
    valueWidth: 32
  };
}

function byteAccess(region: number): ResourceAccess<8> {
  return {
    effect: effect(region, 1),
    address: { base: i32(0), displacement: region * 4 },
    width: 8,
    valueWidth: 8
  };
}

function effect(region: number, byteLength: number): ResourceEffect {
  return {
    space: "resource",
    resource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: region * 4, byteLength }
    }
  };
}

function storeSite(body: WasmBody, region: number): SiteId {
  return eventSite(body, (event) => event.kind === "store" && event.displacement === region * 4);
}

function entryEventSite(body: WasmBody, kind: BodyEvent["kind"]): SiteId {
  return eventSite(
    body,
    (event, site) =>
      event.kind === kind && body.blocks[body.sites[site]!.block]?.parent === undefined
  );
}

function eventSite(body: WasmBody, predicate: (event: BodyEvent, site: SiteId) => boolean): SiteId {
  for (const [index, event] of body.events.entries()) {
    const site = siteId(index);

    if (predicate(event, site)) {
      return site;
    }
  }
  throw new Error("expected Wasm body event");
}
