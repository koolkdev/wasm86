import { ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, nonzero } from "#compiler/function/values.js";
import type { WasmBody } from "#compiler/wasm/function/body.js";
import { wasmValueId, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { placeEvaluations } from "../placement.js";

// Deterministic placement order feeds later local allocation and emission.
test("split evaluations remain adjacent after their dependencies", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[32]], [Integer[32]]), (fn) => {
      const [condition, source] = fn.parameters;
      const producer = source.add(1);
      const masked = producer.and(0xff);

      fn.region.if(nonzero(condition), (unlikely) => unlikely.return([masked]), {
        hint: "unlikely"
      });
      fn.return([masked]);
    })
  );
  const producer = binaryValue(body, "add");
  const masked = binaryValue(body, "and");
  const evaluations = placeEvaluations(body).evaluations;
  const finalized = new Set<WasmValueId>();
  let group: WasmValueId | undefined;

  for (const evaluation of evaluations) {
    if (evaluation.value === group) {
      continue;
    }
    ok(group === undefined || group < evaluation.value);
    ok(!finalized.has(evaluation.value));
    finalized.add(evaluation.value);
    group = evaluation.value;
  }
  const split = evaluations.filter(({ value }) => value === masked);
  const maskPositions = evaluations.flatMap(({ value }, index) =>
    value === masked ? [index] : []
  );
  const producerPosition = evaluations.findIndex(({ value }) => value === producer);

  ok(finalized.has(producer));
  strictEqual(split.length, 2);
  strictEqual(split.filter(({ isDefault }) => isDefault).length, 1);
  ok(maskPositions[0] !== undefined && maskPositions[1] !== undefined);
  strictEqual(maskPositions[1], maskPositions[0] + 1);
  ok(producerPosition >= 0 && producerPosition < maskPositions[0]);
});

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
