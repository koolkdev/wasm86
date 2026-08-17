import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, i32, nonzero } from "#compiler/function/values.js";
import {
  siteId,
  type BlockId,
  type BodyEvent,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { wasmValueId, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { functionRef, resourceRef } from "#compiler/reference.js";
import { placeEvaluations } from "../placement.js";
import { buildWasmSchedule, evaluationForUse, type WasmSchedule } from "../schedule.js";

const resource = resourceRef("test.wasm-plan.schedule");
const repeatedUseType = functionType([Integer[32], Integer[32]], []);
const repeatedUseTarget: CallTarget<typeof repeatedUseType> = {
  kind: "direct",
  ref: functionRef("test.wasm-plan.schedule.repeated-use"),
  type: repeatedUseType,
  effects: { reads: [], writes: [effect(99)] }
};

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
  const schedule = scheduleBody(body);
  const selectedSite = eventSite(
    body,
    (event, block) => event.kind === "return" && block !== body.entryBlock
  );
  const continuationSite = eventSite(
    body,
    (event, block) => event.kind === "return" && block === body.entryBlock
  );
  const selected = evaluationForUse(schedule, masked, selectedSite);
  const continuation = evaluationForUse(schedule, masked, continuationSite);

  ok(selected !== undefined && continuation !== undefined);
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
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [parameter] = fn.parameters;
      const repeated = parameter.add(1);

      fn.region.call(repeatedUseTarget, [repeated, repeated]);
      fn.return([]);
    })
  );
  const repeated = binaryValue(body, "add");
  const schedule = scheduleBody(body);
  const site = eventSite(body, (event) => event.kind === "call");
  const id = evaluationForUse(schedule, repeated, site);

  ok(id !== undefined);
  const evaluation = schedule.evaluations[id];

  ok(evaluation !== undefined);
  strictEqual(evaluation.kind, "atUse");
  ok(evaluation.local !== undefined);
  strictEqual(schedule.localTypes[evaluation.local], "i32");
});

test("capture evaluations are indexed at their anchors", () => {
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
  const schedule = scheduleBody(body);
  const anchor = eventSite(body, (event) => event.kind === "if");
  const id = schedule.defaultEvaluations[shared];

  ok(id !== undefined);
  strictEqual(schedule.evaluations[id]?.kind, "capture");
  deepStrictEqual(schedule.captures[anchor], [id]);
});

test("loop inputs use dedicated locals without synthetic evaluations", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [seed] = fn.parameters;

      fn.region.loop([seed], (loop, [input]) => {
        loop.writeResource(access(0), input);
        loop.loopContinue([input]);
      });
      fn.return([]);
    })
  );
  const loop = onlyEvent(body, "loop");
  const input = loop.inputs[0];

  ok(input !== undefined);
  const schedule = scheduleBody(body);
  const local = schedule.loopInputLocals[input];

  ok(local !== undefined);
  strictEqual(schedule.localTypes[local], "i32");
  strictEqual(schedule.defaultEvaluations[input], undefined);
  strictEqual(
    schedule.evaluations.some((evaluation) => evaluation.value === input),
    false
  );
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
  const branch = onlyEvent(body, "if");

  ok(branch.output !== undefined);
  const schedule = scheduleBody(body);
  const id = schedule.defaultEvaluations[branch.output];

  ok(id !== undefined);
  const evaluation = schedule.evaluations[id];

  ok(evaluation?.local !== undefined);
  strictEqual(evaluation.kind, "join");
  strictEqual(
    evaluation.anchor,
    eventSite(body, (event) => event === branch)
  );
  strictEqual(schedule.localTypes[evaluation.local], "i32");
});

function scheduleBody(body: WasmBody): WasmSchedule {
  return buildWasmSchedule(body, placeEvaluations(body));
}

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

function eventSite(body: WasmBody, matches: (event: BodyEvent, block: BlockId) => boolean): SiteId {
  const found = body.sites.flatMap((site, raw) =>
    matches(site.event, site.block) ? [siteId(raw)] : []
  );

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

function binaryValue(body: WasmBody, operator: string): WasmValueId {
  const found: WasmValueId[] = [];

  for (let raw = 0; raw < body.values.length; raw += 1) {
    const value = wasmValueId(raw);
    const node = body.values.node(value);

    if (node.kind === "binary" && node.operator === operator) {
      found.push(value);
    }
  }
  strictEqual(found.length, 1, `expected one ${operator} value`);
  return found[0] as WasmValueId;
}
