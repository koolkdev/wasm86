import { deepStrictEqual, ok, strictEqual } from "node:assert";
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
  bodyEvent,
  siteId,
  type BodyEvent,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { wasmValueId, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import {
  placeEvaluations,
  seedDemandRoots,
  type EvaluationPlacement,
  type EvaluationSweep
} from "#compiler/wasm/plan/placement.js";

const resource = resourceRef("wasm.plan.evaluations");

function place(body: WasmBody) {
  return { body, sweep: placeEvaluations(body) };
}

function evaluationsFor(
  sweep: EvaluationSweep,
  value: WasmValueId
): readonly EvaluationPlacement[] {
  return sweep.evaluations.filter((evaluation) => evaluation.value === value);
}

function defaultEvaluation(
  sweep: EvaluationSweep,
  value: WasmValueId
): EvaluationPlacement | undefined {
  return sweep.evaluations.find((evaluation) => evaluation.value === value && evaluation.isDefault);
}

test("an operation follows a selected use but cannot cross an aliasing write", () => {
  const movableBody = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;
      const loaded = fn.region.readResource(access(0));

      fn.region.if(nonzero(condition), (selected) => {
        selected.writeResource(access(1), loaded);
      });
      fn.return([]);
    })
  );
  const movableOutput = outputAt(movableBody, loadSite(movableBody, 0));
  const movable = place(movableBody);
  const movableEvaluation = defaultEvaluation(movable.sweep, movableOutput);

  ok(movableEvaluation !== undefined);
  strictEqual(movableEvaluation.kind, "atUse");
  strictEqual(movableEvaluation.anchor, storeSite(movableBody, 1));

  const guardedBody = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;
      const loaded = fn.region.readResource(access(0));

      fn.region.if(nonzero(condition), (selected) => {
        selected.writeResource(access(0), i32(5));
        selected.writeResource(access(1), loaded);
      });
      fn.return([]);
    })
  );
  const guardedOutput = outputAt(guardedBody, loadSite(guardedBody, 0));
  const guarded = place(guardedBody);
  const guardedEvaluation = defaultEvaluation(guarded.sweep, guardedOutput);

  ok(guardedEvaluation !== undefined);
  strictEqual(guardedEvaluation.kind, "capture");
  strictEqual(guardedEvaluation.anchor, loadSite(guardedBody, 0));
});

test("a constant mask gets distinct evaluations for an unlikely exit and the main path", () => {
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
  const producer = binaryValue(body, "add");
  const { sweep } = place(body);
  const evaluations = evaluationsFor(sweep, masked);
  const main = evaluations.find((evaluation) => evaluation.isDefault);
  const unlikely = evaluations.find((evaluation) => !evaluation.isDefault);
  const unlikelySite = nestedEventSite(body, "return");
  const continuationSite = entryEventSite(body, "return");

  strictEqual(evaluations.length, 2);
  ok(main !== undefined);
  ok(unlikely !== undefined);
  strictEqual(main.kind, "atUse");
  strictEqual(main.anchor, continuationSite);
  strictEqual(unlikely.kind, "atUse");
  strictEqual(unlikely.anchor, unlikelySite);
  deepStrictEqual(unlikely.uses, [unlikelySite]);

  const producerEvaluation = defaultEvaluation(sweep, producer);

  ok(producerEvaluation !== undefined);
  strictEqual(producerEvaluation.kind, "capture");
  strictEqual(producerEvaluation.anchor, entryEventSite(body, "if"));
});

test("ordinary arithmetic stays shared across the same hinted paths", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], [Integer[32]]), (fn) => {
      const [condition, source] = fn.parameters;
      const shared = source.add(1);

      fn.region.if(nonzero(condition), (unlikely) => unlikely.return([shared]), {
        hint: "unlikely"
      });
      fn.return([shared]);
    })
  );
  const shared = binaryValue(body, "add");
  const { sweep } = place(body);
  const evaluations = evaluationsFor(sweep, shared);

  strictEqual(evaluations.length, 1);
  strictEqual(evaluations[0]?.kind, "capture");
  strictEqual(evaluations[0]?.anchor, entryEventSite(body, "if"));
});

test("a hint does not split a path that rejoins the continuation", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], []), (fn) => {
      const [condition, source] = fn.parameters;
      const shared = source.and(0xff);

      fn.region.if(nonzero(condition), (unlikely) => unlikely.writeResource(access(0), shared), {
        hint: "unlikely"
      });
      fn.region.writeResource(access(1), shared);
      fn.return([]);
    })
  );
  const shared = binaryValue(body, "and");
  const { sweep } = place(body);
  const evaluations = evaluationsFor(sweep, shared);

  strictEqual(evaluations.length, 1);
  strictEqual(evaluations[0]?.kind, "capture");
  strictEqual(evaluations[0]?.anchor, entryEventSite(body, "if"));
});

test("an unrelated non-speculatable value remains in the switch arms that use it", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32], Integer[32]], []), (fn) => {
      const [selector, numerator, denominator] = fn.parameters;
      const quotient = numerator.unsigned.div(denominator);
      const selected = fn.region.switch(
        selector,
        [
          { match: 0, build: () => quotient },
          { match: 1, build: () => quotient }
        ],
        () => i32(7)
      );

      fn.region.writeResource(access(0), selected);
      fn.return([]);
    })
  );
  const quotient = binaryValue(body, "div_u");
  const { sweep } = place(body);
  const evaluations = evaluationsFor(sweep, quotient);
  const switchSite = entryEventSite(body, "switch");
  const switchEvent = bodyEvent(body, switchSite);

  ok(switchEvent.kind === "switch");
  const armEnds = body.blocks
    .filter(
      (block) => block.ownerSite === switchSite && block.armIndex < switchEvent.caseMatches.length
    )
    .map((block) => block.closeSite);

  strictEqual(evaluations.length, 2);
  strictEqual(armEnds.length, 2);
  deepStrictEqual(new Set(evaluations.map(({ anchor }) => anchor)), new Set(armEnds));
  strictEqual(evaluations.filter(({ isDefault }) => isDefault).length, 1);
});

test("a structured operand establishes a safe capture frontier", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], []), (fn) => {
      const [numerator, denominator] = fn.parameters;
      const quotient = numerator.unsigned.div(denominator);
      const adjusted = quotient.add(1);

      fn.region.if(nonzero(quotient), (then) => then.writeResource(access(0), adjusted), {
        elseBuild: (otherwise) => otherwise.writeResource(access(1), adjusted)
      });
      fn.return([]);
    })
  );
  const quotient = binaryValue(body, "div_u");
  const adjusted = binaryValue(body, "add");
  const { sweep } = place(body);
  const controlSite = entryEventSite(body, "if");
  const quotientEvaluation = defaultEvaluation(sweep, quotient);
  const adjustedEvaluation = defaultEvaluation(sweep, adjusted);

  strictEqual(body.facts.instructionCanSpeculate(adjusted), true);
  strictEqual(body.facts.recipeCanSpeculate(adjusted), false);
  ok(quotientEvaluation !== undefined);
  strictEqual(quotientEvaluation.kind, "atUse");
  strictEqual(quotientEvaluation.anchor, controlSite);
  strictEqual(quotientEvaluation.uses.length, 2);
  ok(adjustedEvaluation !== undefined);
  strictEqual(adjustedEvaluation.kind, "capture");
  strictEqual(adjustedEvaluation.anchor, controlSite);
});

test("an earlier mandatory demand establishes a later capture frontier", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32], Integer[32]], []), (fn) => {
      const [numerator, denominator, condition] = fn.parameters;
      const quotient = numerator.unsigned.div(denominator);
      const adjusted = quotient.add(1);

      fn.region.writeResource(access(2), quotient);
      fn.region.if(nonzero(condition), (then) => then.writeResource(access(0), adjusted), {
        elseBuild: (otherwise) => otherwise.writeResource(access(1), adjusted)
      });
      fn.return([]);
    })
  );
  const quotient = binaryValue(body, "div_u");
  const adjusted = binaryValue(body, "add");
  const { sweep } = place(body);
  const quotientEvaluation = defaultEvaluation(sweep, quotient);
  const adjustedEvaluation = defaultEvaluation(sweep, adjusted);

  ok(quotientEvaluation !== undefined);
  strictEqual(quotientEvaluation.kind, "atUse");
  strictEqual(quotientEvaluation.anchor, storeSite(body, 2));
  strictEqual(quotientEvaluation.uses.length, 2);
  ok(adjustedEvaluation !== undefined);
  strictEqual(adjustedEvaluation.kind, "capture");
  strictEqual(adjustedEvaluation.anchor, entryEventSite(body, "if"));
});

test("loop lifting separates invariant and iteration-scoped recipes", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [parameter] = fn.parameters;
      const invariant = parameter.add(11);

      fn.region.loop([i32(0)], (loop, [input]) => {
        const varying = input.add(13);

        loop.writeResource(access(0), invariant);
        loop.writeResource(access(1), varying);
        loop.loopContinue([varying]);
      });
      fn.return([]);
    })
  );
  const invariant = binaryWithConstant(body, "add", 11);
  const varying = binaryWithConstant(body, "add", 13);
  const { sweep } = place(body);
  const invariantEvaluation = defaultEvaluation(sweep, invariant);
  const varyingEvaluation = defaultEvaluation(sweep, varying);

  ok(invariantEvaluation !== undefined);
  strictEqual(invariantEvaluation.kind, "capture");
  strictEqual(invariantEvaluation.anchor, entryEventSite(body, "loop"));
  ok(varyingEvaluation !== undefined);
  strictEqual(varyingEvaluation.kind, "atUse");
  strictEqual(varyingEvaluation.anchor, storeSite(body, 1));
});

test("an invariant recipe crosses every nested loop boundary", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [parameter] = fn.parameters;
      const invariant = parameter.add(1);

      fn.region.loop([], (outer) => {
        outer.loop([], (inner) => {
          inner.writeResource(access(0), invariant);
          inner.loopContinue([]);
        });
        outer.loopContinue([]);
      });
      fn.return([]);
    })
  );
  const invariant = binaryValue(body, "add");
  const { sweep } = place(body);
  const evaluation = defaultEvaluation(sweep, invariant);

  ok(evaluation !== undefined);
  strictEqual(evaluation.kind, "capture");
  strictEqual(evaluation.anchor, entryEventSite(body, "loop"));
});

test("a loop-local operation output prevents lifting its dependent recipe", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([], []), (fn) => {
      fn.region.loop([], (loop) => {
        const loaded = loop.readResource(access(0));

        loop.writeResource(access(1), loaded.add(1));
        loop.loopContinue([]);
      });
      fn.return([]);
    })
  );
  const adjusted = binaryValue(body, "add");
  const { sweep } = place(body);
  const evaluation = defaultEvaluation(sweep, adjusted);

  ok(evaluation !== undefined);
  strictEqual(evaluation.kind, "atUse");
  strictEqual(evaluation.anchor, storeSite(body, 1));
});

test("join outputs retain their structured producer site", () => {
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
  const controlSite = entryEventSite(body, "if");
  const control = bodyEvent(body, controlSite);

  ok(control.kind === "if" && control.output !== undefined);
  const { sweep } = place(body);
  const evaluation = defaultEvaluation(sweep, control.output);

  ok(evaluation !== undefined);
  strictEqual(evaluation.kind, "join");
  strictEqual(evaluation.anchor, controlSite);
});

test("recorded uses retain repeated consumers for later local decisions", () => {
  const type = functionType([Integer[32]], [Integer[32], Integer[32]]);
  const values = new ValueScope();
  const parameters = values.parameters(type.parameters);
  const [parameter] = parameters;
  const region = new RegionBuilder(values);
  const repeated = parameter.add(1);

  region.return([repeated, repeated]);
  const body = lowerWasmFunction({ type, parameters, entry: region.build(), values });
  const wasmRepeated = binaryValue(body, "add");
  const { sweep } = place(body);
  const evaluation = defaultEvaluation(sweep, wasmRepeated);
  const returnSite = entryEventSite(body, "return");

  ok(evaluation !== undefined);
  strictEqual(evaluation.kind, "atUse");
  deepStrictEqual(evaluation.uses, [returnSite, returnSite]);
});

test("demand roots retain execution order across control arms", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], [Integer[32]]), (fn) => {
      const [condition, base] = fn.parameters;

      fn.region.if(nonzero(condition), (then) => {
        then.writeResource(access(0, base), i32(3));
      });
      fn.return([base]);
    })
  );
  const condition = parameterValue(body, 0);
  const base = parameterValue(body, 1);
  const stored = valueWhere(
    body,
    (node) => node.kind === "const" && node.type === "i32" && node.value === 3
  );
  const branch = entryEventSite(body, "if");
  const store = storeSite(body, 0);
  const returned = entryEventSite(body, "return");

  deepStrictEqual(seedDemandRoots(body), [
    { value: condition, consumedAt: branch },
    { value: base, consumedAt: store },
    { value: stored, consumedAt: store },
    { value: base, consumedAt: returned }
  ]);
});

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

function outputAt(body: WasmBody, site: SiteId): WasmValueId {
  const event = bodyEvent(body, site);

  ok((event.kind === "load" || event.kind === "call") && event.output !== undefined);
  return event.output;
}

function loadSite(body: WasmBody, region: number): SiteId {
  return eventSite(body, (event) => event.kind === "load" && event.displacement === region * 4);
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
  return valueWhere(body, (value) => value.kind === "binary" && value.operator === operator);
}

function parameterValue(body: WasmBody, index: number): WasmValueId {
  return valueWhere(body, (node) => node.kind === "parameter" && node.index === index);
}

function binaryWithConstant(body: WasmBody, operator: string, constant: number): WasmValueId {
  return valueWhere(body, (value) => {
    if (value.kind !== "binary" || value.operator !== operator) {
      return false;
    }
    return value.inputs.some((input) => {
      const node = body.values.node(input);

      return node.kind === "const" && node.type === "i32" && node.value === constant;
    });
  });
}

function valueWhere(
  body: WasmBody,
  predicate: (value: ReturnType<WasmBody["values"]["node"]>) => boolean
): WasmValueId {
  for (let index = 0; index < body.values.length; index += 1) {
    const value = wasmValueId(index);

    if (predicate(body.values.node(value))) {
      return value;
    }
  }
  throw new Error("expected Wasm value");
}
