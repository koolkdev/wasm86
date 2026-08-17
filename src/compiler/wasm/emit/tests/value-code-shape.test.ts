import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { functionType } from "#compiler/function/type.js";
import { Integer } from "#compiler/function/values.js";
import type { BodyEvent, WasmBody } from "#compiler/wasm/function/body.js";
import { siteId } from "#compiler/wasm/function/body.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "#compiler/wasm/plan/function.js";
import { resourceRef } from "#compiler/reference.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmFunctionBindings } from "../bindings.js";
import { ValueEmitter } from "../value.js";
import { recordInstructions } from "./instruction-recorder.js";

type SignedLoadInstruction = "i32.extend8_s" | "i32.load16_u" | "i32.load8_s" | "i32.load8_u";

const instructionNames = new Map<object, SignedLoadInstruction>([
  [wasmInstruction.i32.extend8S, "i32.extend8_s"],
  [wasmInstruction.i32.load16U, "i32.load16_u"],
  [wasmInstruction.i32.load8S, "i32.load8_s"],
  [wasmInstruction.i32.load8U, "i32.load8_u"]
]);
const resource = resourceRef("test.wasm-emit-value.signed-load");

test("a sole signed byte view fuses with its load", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], [Integer[32]]), (fn) => {
      const [address] = fn.parameters;
      const loaded = fn.region.readResource(byteAccess(address));

      fn.return([loaded.signed.extend(32)]);
    })
  );

  deepStrictEqual(emitReturnShape(body), ["i32.load8_s"]);
});

test("shared signed and unsigned byte views keep an explicit extension", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], [Integer[32]]), (fn) => {
      const [address] = fn.parameters;
      const loaded = fn.region.readResource(byteAccess(address));

      fn.return([loaded.signed.extend(32).add(loaded.unsigned.extend(32))]);
    })
  );

  deepStrictEqual(emitReturnShape(body), ["i32.load8_u", "i32.extend8_s"]);
});

test("a signed byte view does not fuse with a wider transfer", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], [Integer[32]]), (fn) => {
      const [address] = fn.parameters;
      const loaded = fn.region.readResource(byteInWordAccess(address));

      fn.return([loaded.signed.extend(32)]);
    })
  );

  deepStrictEqual(emitReturnShape(body), ["i32.load16_u", "i32.extend8_s"]);
});

function emitReturnShape(body: WasmBody): readonly SignedLoadInstruction[] {
  const planned = planWasmFunction(body);
  const returned = onlyReturn(body);
  const emitted = recordInstructions();
  const values = new ValueEmitter({
    writer: emitted.writer,
    bindings,
    body,
    schedule: planned.schedule,
    resolveLocal: (local) => body.parameterCount + local
  });

  values.beginSite(returned.site, returned.event);
  for (const value of returned.event.operands) {
    values.emitUse(value);
  }
  values.assertComplete();

  return emitted.instructions.flatMap(({ instruction }) => {
    const name = instructionNames.get(instruction);

    return name === undefined ? [] : [name];
  });
}

function onlyReturn(body: WasmBody): Readonly<{
  site: ReturnType<typeof siteId>;
  event: Extract<BodyEvent, { kind: "return" }>;
}> {
  const matches = body.sites.flatMap(({ event }, raw) =>
    event.kind === "return" ? [{ site: siteId(raw), event }] : []
  );

  strictEqual(matches.length, 1, "expected one return site");
  return matches[0] as (typeof matches)[number];
}

function byteAccess(base: Integer<32>): ResourceAccess<8> {
  return {
    effect: effect(1),
    address: { base, displacement: 0 },
    storageWidth: 8,
    valueWidth: 8
  };
}

function byteInWordAccess(base: Integer<32>): ResourceAccess<16, 8> {
  return {
    effect: effect(2),
    address: { base, displacement: 0 },
    storageWidth: 16,
    valueWidth: 8
  };
}

function effect(byteLength: number): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "slice", origin: "resource", byteOffset: 0, byteLength }
  };
}

function unexpectedBinding(): never {
  throw new Error("unexpected binding");
}

const bindings: WasmFunctionBindings = {
  functionIndex: unexpectedBinding,
  memoryIndex(ref): number {
    strictEqual(ref, resource);
    return 3;
  }
};
