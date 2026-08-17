import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, i32, nonzero } from "#compiler/function/values.js";
import {
  siteId,
  type BodyEvent,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { wasmValueId, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { functionRef, resourceRef } from "#compiler/reference.js";
import { placeEvaluations, type EvaluationPlacement, type WasmPlacement } from "../placement.js";

const resource = resourceRef("test.wasm-placement.resource");

test("a moved read observes writes on its path but not an earlier sibling arm", () => {
  const afterControl = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;
      const loaded = fn.region.readResource(access(0));

      fn.region.if(nonzero(condition), (then) => {
        then.writeResource(access(0), i32(5));
      });
      fn.region.writeResource(access(1), loaded);
      fn.return([]);
    })
  );
  const pinnedOutput = operationOutput(afterControl, eventSite(afterControl, isLoadAt(0)));
  const pinned = defaultEvaluation(placeEvaluations(afterControl), pinnedOutput);

  ok(pinned !== undefined);
  strictEqual(pinned.kind, "capture");
  strictEqual(pinned.anchor, eventSite(afterControl, isLoadAt(0)));

  const selectedSibling = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;
      const loaded = fn.region.readResource(access(0));

      fn.region.if(nonzero(condition), (then) => then.writeResource(access(0), i32(5)), {
        elseBuild: (otherwise) => otherwise.writeResource(access(1), loaded)
      });
      fn.return([]);
    })
  );
  const movableOutput = operationOutput(selectedSibling, eventSite(selectedSibling, isLoadAt(0)));
  const movable = defaultEvaluation(placeEvaluations(selectedSibling), movableOutput);

  ok(movable !== undefined);
  strictEqual(movable.kind, "atUse");
  strictEqual(movable.anchor, eventSite(selectedSibling, isStoreAt(1)));
});

test("a terminal hint keeps a constant mask on each executing path", () => {
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
  const placement = placeEvaluations(body);
  const masked = binaryValue(body, "and");
  const producer = binaryValue(body, "add");
  const maskEvaluations = evaluationsFor(placement, masked);
  const nestedReturn = eventSite(body, (event, block) => {
    return event.kind === "return" && block !== body.entryBlock;
  });
  const mainReturn = eventSite(body, (event, block) => {
    return event.kind === "return" && block === body.entryBlock;
  });

  strictEqual(maskEvaluations.length, 2);
  deepStrictEqual(
    new Set(maskEvaluations.map(({ anchor }) => anchor)),
    new Set([nestedReturn, mainReturn])
  );
  strictEqual(maskEvaluations.filter(({ isDefault }) => isDefault).length, 1);

  const sharedProducer = defaultEvaluation(placement, producer);
  const branch = eventSite(body, (event) => event.kind === "if");

  ok(sharedProducer !== undefined);
  strictEqual(sharedProducer.kind, "capture");
  strictEqual(sharedProducer.anchor, branch);
});

test("a hint does not split an arm that falls through to the continuation", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], []), (fn) => {
      const [condition, source] = fn.parameters;
      const masked = source.and(0xff);

      fn.region.if(nonzero(condition), (unlikely) => unlikely.writeResource(access(0), masked), {
        hint: "unlikely"
      });
      fn.region.writeResource(access(1), masked);
      fn.return([]);
    })
  );
  const evaluations = evaluationsFor(placeEvaluations(body), binaryValue(body, "and"));

  strictEqual(evaluations.length, 1);
  strictEqual(evaluations[0]?.kind, "capture");
  strictEqual(
    evaluations[0]?.anchor,
    eventSite(body, (event) => event.kind === "if")
  );
});

test("division stays in the switch arms that require it", () => {
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
  const evaluations = evaluationsFor(placeEvaluations(body), quotient);
  const switchSite = eventSite(body, (event) => event.kind === "switch");
  const switched = body.sites[switchSite]?.event;

  ok(switched?.kind === "switch");
  const caseEnds = switched.arms
    .slice(0, switched.caseMatches.length)
    .map((arm) => eventSite(body, (event, block) => event.kind === "end" && block === arm));

  strictEqual(evaluations.length, 2);
  deepStrictEqual(new Set(evaluations.map(({ anchor }) => anchor)), new Set(caseEnds));
  strictEqual(evaluations.filter(({ isDefault }) => isDefault).length, 1);
});

test("a structured operand makes a dependent capture safe at its header", () => {
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
  const placement = placeEvaluations(body);
  const quotient = defaultEvaluation(placement, binaryValue(body, "div_u"));
  const adjusted = defaultEvaluation(placement, binaryValue(body, "add"));
  const branch = eventSite(body, (event) => event.kind === "if");

  ok(quotient !== undefined && adjusted !== undefined);
  strictEqual(quotient.kind, "atUse");
  strictEqual(quotient.anchor, branch);
  strictEqual(adjusted.kind, "capture");
  strictEqual(adjusted.anchor, branch);
});

test("an earlier mandatory use makes a dependent capture safe at a later header", () => {
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
  const placement = placeEvaluations(body);
  const quotient = defaultEvaluation(placement, binaryValue(body, "div_u"));
  const adjusted = defaultEvaluation(placement, binaryValue(body, "add"));

  ok(quotient !== undefined && adjusted !== undefined);
  strictEqual(quotient.anchor, eventSite(body, isStoreAt(2)));
  strictEqual(adjusted.kind, "capture");
  strictEqual(
    adjusted.anchor,
    eventSite(body, (event) => event.kind === "if")
  );
});

test("an effectful call makes its argument available to a later capture", () => {
  const callType = functionType([Integer[32]], [Integer[32]]);
  const preview: CallTarget<typeof callType> = {
    kind: "direct",
    ref: functionRef("test.wasm-placement.discovery-preview"),
    type: callType,
    effects: { reads: [], writes: [] }
  };
  const mandatory: CallTarget<typeof callType> = {
    kind: "direct",
    ref: functionRef("test.wasm-placement.discovered-root"),
    type: callType,
    effects: { reads: [], writes: [effect(3)] }
  };
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32], Integer[32]], []), (fn) => {
      const [numerator, denominator, condition] = fn.parameters;
      const quotient = numerator.unsigned.div(denominator);
      const adjusted = quotient.add(1);

      fn.region.call(preview, [adjusted]);
      fn.region.call(mandatory, [quotient]);
      fn.region.if(nonzero(condition), (then) => then.writeResource(access(0), adjusted), {
        elseBuild: (otherwise) => otherwise.writeResource(access(1), adjusted)
      });
      fn.return([]);
    })
  );
  const placement = placeEvaluations(body);
  const previewCall = eventSite(body, (event) => event.kind === "call" && event.target === preview);
  const mandatoryCall = eventSite(
    body,
    (event) => event.kind === "call" && event.target === mandatory
  );
  const adjusted = defaultEvaluation(placement, binaryValue(body, "add"));

  strictEqual(placement.operationsAtAuthoredSite[previewCall], 0);
  strictEqual(placement.operationsAtAuthoredSite[mandatoryCall], 1);
  ok(adjusted !== undefined);
  strictEqual(adjusted.kind, "capture");
  strictEqual(
    adjusted.anchor,
    eventSite(body, (event) => event.kind === "if")
  );
});

test("loop lifting distinguishes invariants from iteration-scoped evaluations", () => {
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
  const placement = placeEvaluations(body);
  const invariant = defaultEvaluation(placement, binaryWithConstant(body, "add", 11));
  const varying = defaultEvaluation(placement, binaryWithConstant(body, "add", 13));
  const loop = eventSite(body, (event) => event.kind === "loop");

  ok(invariant !== undefined && varying !== undefined);
  strictEqual(invariant.kind, "capture");
  strictEqual(invariant.anchor, loop);
  strictEqual(varying.kind, "atUse");
  strictEqual(varying.anchor, eventSite(body, isStoreAt(1)));
});

test("an invariant crosses nested loops but a loop-local operation dependency does not", () => {
  const invariantBody = lowerWasmFunction(
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
  const invariant = defaultEvaluation(
    placeEvaluations(invariantBody),
    binaryValue(invariantBody, "add")
  );
  const outerLoop = eventSite(invariantBody, (event, block) => {
    return event.kind === "loop" && block === invariantBody.entryBlock;
  });

  ok(invariant !== undefined);
  strictEqual(invariant.anchor, outerLoop);

  const localBody = lowerWasmFunction(
    buildFunction(functionType([], []), (fn) => {
      fn.region.loop([], (loop) => {
        const loaded = loop.readResource(access(0));

        loop.writeResource(access(1), loaded.add(1));
        loop.loopContinue([]);
      });
      fn.return([]);
    })
  );
  const local = defaultEvaluation(placeEvaluations(localBody), binaryValue(localBody, "add"));

  ok(local !== undefined);
  strictEqual(local.anchor, eventSite(localBody, isStoreAt(1)));
});

test("a join is placed at its producer and evaluates each arm dependency at its end", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], []), (fn) => {
      const [condition, source] = fn.parameters;
      const selected = fn.region.ifValue(
        nonzero(condition),
        () => source.add(1),
        () => source.add(2)
      );

      fn.region.writeResource(access(0), selected);
      fn.return([]);
    })
  );
  const branch = eventSite(body, (event) => event.kind === "if");
  const event = body.sites[branch]?.event;

  ok(event?.kind === "if" && event.output !== undefined);
  const placement = placeEvaluations(body);
  const evaluation = defaultEvaluation(placement, event.output);

  ok(evaluation !== undefined);
  strictEqual(evaluation.kind, "join");
  strictEqual(evaluation.anchor, branch);
  for (const [constant, arm] of [1, 2].map(
    (constant, index) => [constant, event.arms[index]] as const
  )) {
    ok(arm !== undefined);
    const dependency = defaultEvaluation(placement, binaryWithConstant(body, "add", constant));

    ok(dependency !== undefined);
    strictEqual(
      dependency.anchor,
      eventSite(body, (candidate, block) => {
        return candidate.kind === "end" && block === arm;
      })
    );
  }
});

test("an unused join does not demand its arm results", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], []), (fn) => {
      const [condition, source] = fn.parameters;

      fn.region.ifValue(
        nonzero(condition),
        () => source.add(1),
        () => source.add(2)
      );
      fn.return([]);
    })
  );
  const placement = placeEvaluations(body);

  strictEqual(defaultEvaluation(placement, binaryWithConstant(body, "add", 1)), undefined);
  strictEqual(defaultEvaluation(placement, binaryWithConstant(body, "add", 2)), undefined);
});

test("repeated consumers at one site remain distinct demands", () => {
  const targetType = functionType([Integer[32], Integer[32]], []);
  const target: CallTarget<typeof targetType> = {
    kind: "direct",
    ref: functionRef("test.wasm-placement.repeated-consumer"),
    type: targetType,
    effects: { reads: [], writes: [effect(3)] }
  };
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [source] = fn.parameters;
      const repeated = source.add(1);

      fn.region.call(target, [repeated, repeated]);
      fn.return([]);
    })
  );
  const evaluation = defaultEvaluation(placeEvaluations(body), binaryValue(body, "add"));
  const calledAt = eventSite(body, (event) => event.kind === "call");

  ok(evaluation !== undefined);
  deepStrictEqual(evaluation.uses, [calledAt, calledAt]);
});

test("only effectful dead operations remain at their authored sites", () => {
  const resultType = functionType([Integer[32]], [Integer[32]]);
  const effectful: CallTarget<typeof resultType> = {
    kind: "direct",
    ref: functionRef("test.wasm-placement.effectful"),
    type: resultType,
    effects: { reads: [], writes: [effect(0)] }
  };
  const pure: CallTarget<typeof resultType> = {
    kind: "direct",
    ref: functionRef("test.wasm-placement.pure"),
    type: resultType,
    effects: { reads: [], writes: [] }
  };
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [parameter] = fn.parameters;

      fn.region.call(effectful, [parameter.add(1)]);
      fn.region.call(pure, [parameter.add(2)]);
      fn.return([]);
    })
  );
  const placement = placeEvaluations(body);
  const effectfulSite = eventSite(
    body,
    (event) => event.kind === "call" && event.target === effectful
  );
  const pureSite = eventSite(body, (event) => event.kind === "call" && event.target === pure);
  const requiredArgument = defaultEvaluation(placement, binaryWithConstant(body, "add", 1));

  strictEqual(placement.operationsAtAuthoredSite[effectfulSite], 1);
  strictEqual(placement.operationsAtAuthoredSite[pureSite], 0);
  ok(requiredArgument !== undefined);
  strictEqual(requiredArgument.anchor, effectfulSite);
  strictEqual(defaultEvaluation(placement, binaryWithConstant(body, "add", 2)), undefined);
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

function evaluationsFor(
  placement: WasmPlacement,
  value: WasmValueId
): readonly EvaluationPlacement[] {
  return placement.evaluations.filter((evaluation) => evaluation.value === value);
}

function defaultEvaluation(
  placement: WasmPlacement,
  value: WasmValueId
): EvaluationPlacement | undefined {
  return placement.evaluations.find(
    (evaluation) => evaluation.value === value && evaluation.isDefault
  );
}

function operationOutput(body: WasmBody, site: SiteId): WasmValueId {
  const event = body.sites[site]?.event;

  ok(event?.kind === "load" || event?.kind === "call");
  ok(event.output !== undefined);
  return event.output;
}

function binaryValue(body: WasmBody, operator: string): WasmValueId {
  return valueWhere(body, (value) => value.kind === "binary" && value.operator === operator);
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
  matches: (value: ReturnType<WasmBody["values"]["node"]>) => boolean
): WasmValueId {
  const found: WasmValueId[] = [];

  for (let raw = 0; raw < body.values.length; raw += 1) {
    const value = wasmValueId(raw);

    if (matches(body.values.node(value))) {
      found.push(value);
    }
  }
  strictEqual(found.length, 1, "expected one matching Wasm value");
  return found[0] as WasmValueId;
}

function isLoadAt(region: number): (event: BodyEvent) => boolean {
  return (event) => event.kind === "load" && event.displacement === region * 4;
}

function isStoreAt(region: number): (event: BodyEvent) => boolean {
  return (event) => event.kind === "store" && event.displacement === region * 4;
}

function eventSite(
  body: WasmBody,
  matches: (event: BodyEvent, block: WasmBody["entryBlock"]) => boolean
): SiteId {
  const found = body.sites.flatMap((site, raw) =>
    matches(site.event, site.block) ? [siteId(raw)] : []
  );

  strictEqual(found.length, 1, "expected one matching body event");
  return found[0] as SiteId;
}
