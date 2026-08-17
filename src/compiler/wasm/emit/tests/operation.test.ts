import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { noStorageEffects, type VariableRef } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Float, Integer } from "#compiler/function/values.js";
import type { BodyEvent, WasmBody } from "#compiler/wasm/function/body.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { functionRef, resourceRef } from "#compiler/reference.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { wasmInstruction } from "#wasm/encoder/instructions.js";
import type { WasmFunctionBindings } from "../bindings.js";
import { emitWasmOperation } from "../operation.js";
import { recordInstructions } from "./instruction-recorder.js";

const resource = resourceRef("test.wasm-emit-operation.resource");

test("memory operations resolve their resource and preserve transfer immediates", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32], Integer[64]], [Integer[8]]), (fn) => {
      const [address, wide] = fn.parameters;
      const loaded = fn.region.readResource(byteAccess(address));

      fn.region.writeResource(qwordAccess(address), wide);
      fn.return([loaded]);
    })
  );
  const load = onlyEvent(body, "load");
  const store = onlyEvent(body, "store");
  const uses: WasmValueId[] = [];
  const emitted = recordInstructions();
  const bindings: WasmFunctionBindings = {
    functionIndex: unexpectedFunctionBinding,
    memoryIndex(ref) {
      strictEqual(ref, resource);
      return 3;
    }
  };
  const values = {
    emitUse(value: WasmValueId): void {
      uses.push(value);
    },
    variableLocal: unexpectedVariable
  };

  emitWasmOperation(emitted.writer, bindings, values, load);
  emitWasmOperation(emitted.writer, bindings, values, load, "signed");
  emitWasmOperation(emitted.writer, bindings, values, store);

  deepStrictEqual(uses, [load.address, load.address, store.address, store.value]);
  deepStrictEqual(emitted.instructions, [
    {
      instruction: wasmInstruction.i32.load8U,
      arguments: [{ align: 0, offset: 5, memoryIndex: 3 }]
    },
    {
      instruction: wasmInstruction.i32.load8S,
      arguments: [{ align: 0, offset: 5, memoryIndex: 3 }]
    },
    {
      instruction: wasmInstruction.i64.store,
      arguments: [{ align: 3, offset: 13, memoryIndex: 3 }]
    }
  ]);
});

test("direct calls resolve their function and emit arguments in order", () => {
  const targetType = functionType([Integer[32], Float[32]], [Integer[32]]);
  const target: CallTarget<typeof targetType> = {
    kind: "direct",
    ref: functionRef("test.wasm-emit-operation.target"),
    type: targetType,
    effects: noStorageEffects
  };
  const body = lowerWasmFunction(
    buildFunction(targetType, (fn) => {
      const [result] = fn.region.call(target, fn.parameters);

      fn.return([result]);
    })
  );
  const call = onlyEvent(body, "call");
  const uses: WasmValueId[] = [];
  const emitted = recordInstructions();
  const bindings: WasmFunctionBindings = {
    functionIndex(ref) {
      strictEqual(ref, target.ref);
      return 11;
    },
    memoryIndex: unexpectedMemoryBinding
  };

  emitWasmOperation(
    emitted.writer,
    bindings,
    {
      emitUse(value): void {
        uses.push(value);
      },
      variableLocal: unexpectedVariable
    },
    call
  );

  deepStrictEqual(uses, call.operands);
  deepStrictEqual(emitted.instructions, [
    { instruction: wasmInstruction.call.direct, arguments: [11] }
  ]);
});

test("variable operations use their assigned local", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Float[64]], [Float[64]]), (fn) => {
      const [parameter] = fn.parameters;
      const variable = fn.region.variable(parameter);

      fn.region.write(variable, parameter.add(1));
      fn.return([fn.region.read(variable)]);
    })
  );
  const update = body.sites
    .map(({ event }) => event)
    .find((event) => event.kind === "variableWrite" && event.initialization === "update");
  const read = onlyEvent(body, "variableRead");

  strictEqual(update?.kind, "variableWrite");
  if (update?.kind !== "variableWrite") {
    return;
  }
  const uses: WasmValueId[] = [];
  const emitted = recordInstructions();
  const values = {
    emitUse(value: WasmValueId): void {
      uses.push(value);
    },
    variableLocal(variable: VariableRef): number {
      strictEqual(variable, update.variable);
      return 8;
    }
  };

  emitWasmOperation(emitted.writer, unusedBindings, values, update);
  emitWasmOperation(emitted.writer, unusedBindings, values, read);

  deepStrictEqual(uses, [update.value]);
  deepStrictEqual(emitted.instructions, [
    { instruction: wasmInstruction.local.set, arguments: [8] },
    { instruction: wasmInstruction.local.get, arguments: [8] }
  ]);
});

function byteAccess(base: Integer<32>): ResourceAccess<8> {
  return {
    effect: effect(5, 1),
    address: { base, displacement: 5 },
    storageWidth: 8,
    valueWidth: 8
  };
}

function qwordAccess(base: Integer<32>): ResourceAccess<64> {
  return {
    effect: effect(13, 8),
    address: { base, displacement: 13 },
    storageWidth: 64,
    valueWidth: 64
  };
}

function effect(byteOffset: number, byteLength: number): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "slice", origin: "resource", byteOffset, byteLength }
  };
}

function onlyEvent<Kind extends BodyEvent["kind"]>(
  body: WasmBody,
  kind: Kind
): Extract<BodyEvent, { kind: Kind }> {
  const matches = body.sites.flatMap((site) => (site.event.kind === kind ? [site.event] : []));

  strictEqual(matches.length, 1, `expected one ${kind} event`);
  return matches[0] as Extract<BodyEvent, { kind: Kind }>;
}

function unexpectedFunctionBinding(): never {
  throw new Error("unexpected function binding");
}

function unexpectedMemoryBinding(): never {
  throw new Error("unexpected memory binding");
}

function unexpectedVariable(): never {
  throw new Error("unexpected variable local");
}

const unusedBindings: WasmFunctionBindings = {
  functionIndex: unexpectedFunctionBinding,
  memoryIndex: unexpectedMemoryBinding
};
