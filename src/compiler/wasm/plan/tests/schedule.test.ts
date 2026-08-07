import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { buildFunction } from "#compiler/function/builder/function.js";
import { RegionBuilder } from "#compiler/function/builder/region.js";
import { Integer, functionType } from "#compiler/function/type.js";
import type { ResourceAccess } from "#compiler/function/resource.js";
import { ValueScope } from "#compiler/function/values/scope.js";
import { i32, nonzero } from "#compiler/function/values.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import { resourceRef } from "#compiler/reference.js";
import {
  siteId,
  type BodyEvent,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { wasmValueId, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { placeEvaluations, type WasmEvaluation } from "#compiler/wasm/plan/placement.js";
import {
  buildWasmSchedule,
  evaluationForUse,
  type WasmSchedule
} from "#compiler/wasm/plan/schedule.js";

const resource = resourceRef("wasm.plan.schedule");

function buildSchedule(body: WasmBody) {
  return { schedule: buildWasmSchedule(body, placeEvaluations(body)) };
}

function defaultEvaluation(schedule: WasmSchedule, value: WasmValueId): WasmEvaluation | undefined {
  const id = schedule.defaultEvaluations[value];

  return id === undefined ? undefined : schedule.evaluations[id];
}

test("a selected-path evaluation overrides the default only at its uses", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], [Integer[32]]), (fn) => {
      const [condition, source] = fn.parameters;
      const masked = source.add(1).and(0xff);

      fn.region.if(nonzero(condition), (unlikely) => unlikely.return([masked]), {
        hint: "unlikely"
      });
      fn.return([masked]);
    })
  );
  const masked = binaryValue(body, "and");
  const { schedule } = buildSchedule(body);
  const selectedSite = nestedEventSite(body, "return");
  const continuationSite = entryEventSite(body, "return");
  const selected = evaluationForUse(schedule, masked, selectedSite);
  const continuation = evaluationForUse(schedule, masked, continuationSite);

  ok(selected !== undefined);
  ok(continuation !== undefined);
  notStrictEqual(selected, continuation);
  strictEqual(schedule.useOverrides[selectedSite]?.get(masked), selected);
  strictEqual(schedule.useOverrides[continuationSite], undefined);
  strictEqual(schedule.evaluations[selected]?.kind, "atUse");
  strictEqual(schedule.evaluations[selected]?.anchor, selectedSite);
  strictEqual(schedule.evaluations[selected]?.local, undefined);
  strictEqual(schedule.evaluations[continuation]?.kind, "atUse");
  strictEqual(schedule.evaluations[continuation]?.anchor, continuationSite);
  strictEqual(schedule.evaluations[continuation]?.local, undefined);
});

test("repeated uses at one site share one typed local", () => {
  const type = functionType([Integer[32]], [Integer[32], Integer[32]]);
  const values = new ValueScope();
  const parameters = values.parameters(type.parameters);
  const [parameter] = parameters;
  const region = new RegionBuilder(values);
  const repeated = parameter.add(1);

  region.return([repeated, repeated]);
  const body = lowerWasmFunction({ type, parameters, entry: region.build(), values });
  const wasmRepeated = binaryValue(body, "add");
  const { schedule } = buildSchedule(body);
  const site = entryEventSite(body, "return");
  const id = evaluationForUse(schedule, wasmRepeated, site);

  ok(id !== undefined);
  const evaluation = schedule.evaluations[id];

  ok(evaluation?.kind === "atUse");
  strictEqual(evaluation.uses.length, 2);
  ok(evaluation.local !== undefined);
  strictEqual(schedule.localTypes[evaluation.local], "i32");
});

test("a capture is scheduled at its evaluation anchor", () => {
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
  const shared = binaryValue(body, "add");
  const { schedule } = buildSchedule(body);
  const site = entryEventSite(body, "if");
  const id = schedule.defaultEvaluations[shared];

  ok(id !== undefined);
  strictEqual(defaultEvaluation(schedule, shared)?.kind, "capture");
  deepStrictEqual(schedule.captures[site], [id]);
});

test("a nested loop input receives one local anchored at its loop header", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;

      fn.region.if(nonzero(condition), (then) => {
        then.loop([i32(0)], (loop, [input]) => {
          loop.writeResource(access(0), input);
          loop.loopContinue([input]);
        });
      });
      fn.return([]);
    })
  );
  const loopSite = eventSite(body, (event) => event.kind === "loop");
  const loop = body.events[loopSite];

  ok(loop?.kind === "loop");
  const loopInput = loop.loopInputs[0];

  ok(loopInput !== undefined);
  const { schedule } = buildSchedule(body);
  const id = schedule.defaultEvaluations[loopInput];

  ok(id !== undefined);
  const evaluation = schedule.evaluations[id];

  ok(evaluation?.kind === "loopInput");
  strictEqual(evaluation.anchor, loopSite);
  ok(evaluation.local !== undefined);
  strictEqual(schedule.localTypes[evaluation.local], "i32");
});

test("a structured join owns one typed result local", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;
      const selected = fn.region.ifValue(
        nonzero(condition),
        () => i32(1),
        () => i32(2)
      );

      fn.region.writeResource(access(0), selected);
      fn.return([]);
    })
  );
  const site = entryEventSite(body, "if");
  const branch = body.events[site];

  ok(branch?.kind === "if" && branch.output !== undefined);
  const { schedule } = buildSchedule(body);
  const evaluation = defaultEvaluation(schedule, branch.output);

  ok(evaluation?.kind === "join");
  strictEqual(evaluation.anchor, site);
  ok(evaluation.local !== undefined);
  strictEqual(schedule.localTypes[evaluation.local], "i32");
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

function entryEventSite(body: WasmBody, kind: BodyEvent["kind"]): SiteId {
  return eventSite(
    body,
    (event, site) =>
      event.kind === kind && body.blocks[body.sites[site]!.block]?.parent === undefined
  );
}

function nestedEventSite(body: WasmBody, kind: BodyEvent["kind"]): SiteId {
  return eventSite(
    body,
    (event, site) =>
      event.kind === kind && body.blocks[body.sites[site]!.block]?.parent !== undefined
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

function binaryValue(body: WasmBody, operator: string): WasmValueId {
  for (let index = 0; index < body.values.length; index += 1) {
    const value = wasmValueId(index);
    const node = body.values.node(value);

    if (node.kind === "binary" && node.operator === operator) {
      return value;
    }
  }
  throw new Error(`expected ${operator} value`);
}
