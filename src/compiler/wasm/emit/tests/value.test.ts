import { deepStrictEqual, strictEqual } from "node:assert";
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
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "#compiler/wasm/plan/function.js";
import { functionRef, resourceRef } from "#compiler/reference.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmFunctionBindings } from "../bindings.js";
import { emitWasmOperation } from "../operation.js";
import { ValueEmitter } from "../value.js";
import { recordInstructions } from "./instruction-recorder.js";

const resource = resourceRef("test.wasm-emit-value.resource");
const repeatedUseType = functionType([Integer[32], Integer[32]], []);
const repeatedUseTarget: CallTarget<typeof repeatedUseType> = {
  kind: "direct",
  ref: functionRef("test.wasm-emit-value.repeated-use"),
  type: repeatedUseType,
  effects: { reads: [], writes: [effect(8)] }
};

test("structured headers emit their operand before scheduled captures", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], []), (fn) => {
      const [condition, source] = fn.parameters;
      const captured = source.add(1);

      fn.region.if(nonzero(condition), (then) => then.writeResource(access(0), captured), {
        elseBuild: (otherwise) => otherwise.writeResource(access(4), captured)
      });
      fn.return([]);
    })
  );
  const planned = planWasmFunction(body);
  const branchSite = onlySite(body, "if");
  const branch = branchSite.event;
  const storeSite = firstSite(body, "store");
  const emitted = recordInstructions();
  const values = new ValueEmitter({
    writer: emitted.writer,
    bindings: unusedBindings,
    body,
    schedule: planned.schedule,
    resolveLocal: (local) => body.parameterCount + local
  });

  values.beginSite(branchSite.id, branch);
  values.emitUse(branch.condition);
  strictEqual(
    emitted.instructions.some(({ instruction }) => instruction === wasmInstruction.local.set),
    false
  );

  const beforeCapture = emitted.instructions.length;

  values.emitCaptures();
  const captureWrites = emitted.instructions
    .slice(beforeCapture)
    .filter(({ instruction }) => instruction === wasmInstruction.local.set);

  strictEqual(captureWrites.length, 1);
  const capturedLocal = captureWrites[0]?.arguments[0];

  strictEqual(typeof capturedLocal, "number");

  const beforeUse = emitted.instructions.length;

  values.beginSite(storeSite.id, storeSite.event);
  values.emitUse(storeSite.event.value);

  deepStrictEqual(emitted.instructions.slice(beforeUse), [
    { instruction: wasmInstruction.local.get, arguments: [capturedLocal] }
  ]);
  values.assertComplete();
});

test("repeated uses at one site realize once and replay their local", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [parameter] = fn.parameters;
      const repeated = parameter.add(1);

      fn.region.call(repeatedUseTarget, [repeated, repeated]);
      fn.return([]);
    })
  );
  const planned = planWasmFunction(body);
  const callSite = onlySite(body, "call");
  const emitted = recordInstructions();
  const values = new ValueEmitter({
    writer: emitted.writer,
    bindings: valuesBindings,
    body,
    schedule: planned.schedule,
    resolveLocal: (local) => body.parameterCount + local
  });

  values.beginSite(callSite.id, callSite.event);
  emitWasmOperation(emitted.writer, valuesBindings, values, callSite.event);

  const replay = emitted.instructions.filter(
    ({ instruction }) =>
      instruction === wasmInstruction.i32.add ||
      instruction === wasmInstruction.local.tee ||
      instruction === wasmInstruction.local.get
  );
  const local = replay.find(({ instruction }) => instruction === wasmInstruction.local.tee)
    ?.arguments[0];

  strictEqual(typeof local, "number");
  deepStrictEqual(replay, [
    { instruction: wasmInstruction.local.get, arguments: [0] },
    { instruction: wasmInstruction.i32.add, arguments: [] },
    { instruction: wasmInstruction.local.tee, arguments: [local] },
    { instruction: wasmInstruction.local.get, arguments: [local] }
  ]);
  values.assertComplete();
});

type EventSite<Kind extends BodyEvent["kind"]> = Readonly<{
  id: SiteId;
  event: Extract<BodyEvent, { kind: Kind }>;
}>;

function onlySite<Kind extends BodyEvent["kind"]>(body: WasmBody, kind: Kind): EventSite<Kind> {
  const matches = sites(body, kind);

  strictEqual(matches.length, 1, `expected one ${kind} site`);
  return matches[0] as EventSite<Kind>;
}

function firstSite<Kind extends BodyEvent["kind"]>(body: WasmBody, kind: Kind): EventSite<Kind> {
  const match = sites(body, kind)[0];

  strictEqual(match !== undefined, true, `expected a ${kind} site`);
  return match as EventSite<Kind>;
}

function sites<Kind extends BodyEvent["kind"]>(body: WasmBody, kind: Kind): EventSite<Kind>[] {
  return body.sites.flatMap(({ event }, raw) =>
    event.kind === kind
      ? [{ id: siteId(raw), event: event as Extract<BodyEvent, { kind: Kind }> }]
      : []
  );
}

function access(displacement: number): ResourceAccess<32> {
  return {
    effect: effect(displacement),
    address: { base: i32(0), displacement },
    storageWidth: 32,
    valueWidth: 32
  };
}

function effect(displacement: number): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: {
      kind: "slice",
      origin: "resource",
      byteOffset: displacement,
      byteLength: 4
    }
  };
}

function unexpectedBinding(): never {
  throw new Error("unexpected binding");
}

const unusedBindings: WasmFunctionBindings = {
  functionIndex: unexpectedBinding,
  memoryIndex: unexpectedBinding
};

const valuesBindings: WasmFunctionBindings = {
  functionIndex(ref): number {
    strictEqual(ref, repeatedUseTarget.ref);
    return 7;
  },
  memoryIndex: unexpectedBinding
};
