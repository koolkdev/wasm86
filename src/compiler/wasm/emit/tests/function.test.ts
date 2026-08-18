import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import type { FunctionBody } from "#compiler/function/body.js";
import { buildFunction } from "#compiler/function/builder/function.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { noStorageEffects } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import { Float, Integer, f64, i32, nonzero, unreachable } from "#compiler/function/values.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "#compiler/wasm/plan/function.js";
import { functionRef, resourceRef } from "#compiler/reference.js";
import {
  encodeWasmModule,
  type WasmFunctionImport,
  type WasmMemoryImport
} from "#wasm/encoder/module.js";
import type { EncodedWasmFunctionBody } from "#wasm/encoder/function-body.js";
import type { WasmFunctionType } from "#wasm/types.js";
import type { WasmFunctionBindings } from "../bindings.js";
import { emitWasmFunctionBody } from "../function.js";

const resource = resourceRef("test.wasm-emit-function.resource");

test("if and switch joins execute their selected arms and retain branch hints", async () => {
  const type = functionType([Integer[1], Integer[8]], [Float[64]]);
  const body = emitFunction(
    buildFunction(type, (fn) => {
      const [condition, selector] = fn.parameters;
      const selected = fn.region.ifValue(
        condition,
        (then) =>
          then.switch(
            selector,
            [
              { match: 1, build: () => f64(11) },
              { match: 4, build: () => f64(44) }
            ],
            () => f64(99)
          ),
        () => f64(-1),
        { hint: "likely" }
      );

      fn.return([selected.add(1)]);
    })
  );
  const select = await instantiateSingle(
    { parameters: ["i32", "i32"], results: ["f64"] },
    body,
    "select"
  );

  strictEqual(select(0, 1), 0);
  strictEqual(select(1, 1), 12);
  strictEqual(select(1, 4), 45);
  strictEqual(select(1, 7), 100);
  deepStrictEqual(
    body.branchHints.map(({ value }) => value),
    [1]
  );
});

test("an all-terminal switch seals its join and dispatches grouped matches", async () => {
  const type = functionType([Integer[8]], [Integer[32]]);
  const body = emitFunction(
    buildFunction(type, (fn) => {
      const [selector] = fn.parameters;

      fn.region.switchControl(
        selector,
        [
          { matches: [1, 4], build: (arm) => arm.return([i32(14)]) },
          { matches: [2, 7], build: (arm) => arm.return([i32(27)]) }
        ],
        (otherwise) => otherwise.return([i32(99)])
      );
    })
  );
  const dispatch = await instantiateSingle(
    { parameters: ["i32"], results: ["i32"] },
    body,
    "dispatch"
  );

  strictEqual(dispatch(1), 14);
  strictEqual(dispatch(4), 14);
  strictEqual(dispatch(7), 27);
  strictEqual(dispatch(8), 99);
});

test("a one-arm terminal if preserves its implicit fallthrough", async () => {
  const type = functionType([Integer[1]], [Integer[32]]);
  const body = emitFunction(
    buildFunction(type, (fn) => {
      const [condition] = fn.parameters;

      fn.region.if(condition, (then) => then.return([i32(1)]));
      fn.return([i32(2)]);
    })
  );
  const choose = await instantiateSingle({ parameters: ["i32"], results: ["i32"] }, body, "choose");

  strictEqual(choose(0), 2);
  strictEqual(choose(1), 1);
});

test("nested loop continues update carried values in parallel", async () => {
  const type = functionType([Integer[32], Integer[32], Integer[32]], [Integer[32]]);
  const body = emitFunction(
    buildFunction(type, (fn) => {
      const [left, right, count] = fn.parameters;
      const result = fn.region.variable(i32(-1));

      fn.region.loop([left, right, count], (loop, [currentLeft, currentRight, remaining]) => {
        loop.if(
          nonzero(remaining),
          (again) => again.loopContinue([currentRight, currentLeft, remaining.sub(1)]),
          {
            elseBuild: (done) => done.write(result, currentLeft.mul(100).add(currentRight))
          }
        );
      });
      fn.return([fn.region.read(result)]);
    })
  );
  const swap = await instantiateSingle(
    { parameters: ["i32", "i32", "i32"], results: ["i32"] },
    body,
    "swap"
  );

  strictEqual(swap(1, 2, 0), 102);
  strictEqual(swap(1, 2, 1), 201);
  strictEqual(swap(1, 2, 2), 102);
});

test("authored operations emit live and dropped call results exactly once", async () => {
  const type = functionType([Integer[32]], [Integer[32]]);
  const target: CallTarget<typeof type> = {
    kind: "direct",
    ref: functionRef("test.wasm-emit-function.transform"),
    type,
    effects: { reads: [], writes: [effect(8)] }
  };
  const body = emitFunction(
    buildFunction(type, (fn) => {
      const [address] = fn.parameters;
      const loaded = fn.region.readResource(wordAccess(address, 0));
      const [transformed] = fn.region.call(target, [loaded]);

      fn.region.writeResource(wordAccess(address, 4), transformed);
      fn.region.if(nonzero(transformed), (arm) => {
        // This write-retained call has a dead result. The fallthrough arm owns
        // an empty Wasm stack, so whole-function emission must drop its value.
        arm.call(target, [transformed]);
      });
      fn.return([transformed]);
    }),
    {
      functionIndex(ref): number {
        strictEqual(ref, target.ref);
        return 0;
      },
      memoryIndex(ref): number {
        strictEqual(ref, resource);
        return 0;
      }
    }
  );
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  let calls = 0;

  view.setInt32(0, 41, true);
  view.setInt32(8, -1, true);
  const bytes = moduleBytes({
    types: [{ parameters: ["i32"], results: ["i32"] }],
    functionImports: [{ moduleName: "env", name: "transform", typeIndex: 0 }],
    memoryImports: [{ moduleName: "env", name: "memory", limits: { minPages: 1 } }],
    functions: [{ typeIndex: 0, body }],
    exports: [{ name: "transformAt", functionIndex: 1 }]
  });
  const instance = await WebAssembly.instantiate(bytes, {
    env: {
      memory,
      transform(value: number): number {
        calls += 1;
        return value + 1;
      }
    }
  });
  const transformAt = exportedFunction(instance.instance, "transformAt");

  strictEqual(transformAt(0), 42);
  strictEqual(view.getInt32(4, true), 42);
  strictEqual(transformAt(8), 0);
  strictEqual(view.getInt32(12, true), 0);
  strictEqual(calls, 3, "the conditional dead-result call must execute only for nonzero output");
});

test("typed floating-point functions execute through the Wasm ABI", async () => {
  const f32Type = functionType([Float[32]], [Float[32]]);
  const f32Body = emitFunction(
    buildFunction(f32Type, (fn) => {
      const [value] = fn.parameters;

      fn.return([value.mul(2).add(1)]);
    })
  );
  const f64Type = functionType([Float[64]], [Float[64]]);
  const f64Body = emitFunction(
    buildFunction(f64Type, (fn) => {
      const [value] = fn.parameters;

      fn.return([value.div(2).sub(1)]);
    })
  );
  const bytes = moduleBytes({
    types: [
      { parameters: ["f32"], results: ["f32"] },
      { parameters: ["f64"], results: ["f64"] }
    ],
    functions: [
      { typeIndex: 0, body: f32Body },
      { typeIndex: 1, body: f64Body }
    ],
    exports: [
      { name: "single", functionIndex: 0 },
      { name: "double", functionIndex: 1 }
    ]
  });
  const instance = await WebAssembly.instantiate(bytes);
  const single = exportedFunction(instance.instance, "single");
  const double = exportedFunction(instance.instance, "double");

  strictEqual(single(2.5), 6);
  strictEqual(double(8), 3);
});

test("dead pure calls and unused join results emit no latent work", async () => {
  const targetType = functionType([], [Integer[32]]);
  const target: CallTarget<typeof targetType> = {
    kind: "direct",
    ref: functionRef("test.wasm-emit-function.dead-call"),
    type: targetType,
    effects: noStorageEffects
  };
  let resolutions = 0;
  const type = functionType([Integer[1]], [Integer[32]]);
  const body = emitFunction(
    buildFunction(type, (fn) => {
      const [condition] = fn.parameters;

      fn.region.call(target, []);
      fn.region.ifValue(
        condition,
        () => i32(7),
        () => unreachable()
      );
      fn.return([i32(23)]);
    }),
    {
      functionIndex(): number {
        resolutions += 1;
        return 0;
      },
      memoryIndex: unexpectedBinding
    }
  );
  const run = await instantiateSingle({ parameters: ["i32"], results: ["i32"] }, body, "run");

  strictEqual(run(0), 23);
  strictEqual(run(1), 23);
  strictEqual(resolutions, 0);
});

test("self return calls keep deep recursion on a bounded stack", async () => {
  const type = functionType([Integer[32]], [Integer[32]]);
  const self: CallTarget<typeof type> = {
    kind: "direct",
    ref: functionRef("test.wasm-emit-function.self-tail-call"),
    type,
    effects: noStorageEffects
  };
  const entry = emitFunction(
    buildFunction(type, (fn) => {
      const [remaining] = fn.parameters;

      fn.region.if(nonzero(remaining), (again) => again.returnCall(self, [remaining.sub(1)]), {
        elseBuild: (done) => done.return([i32(77)])
      });
    }),
    {
      functionIndex(ref): number {
        strictEqual(ref, self.ref);
        return 0;
      },
      memoryIndex: unexpectedBinding
    }
  );
  const bytes = moduleBytes({
    types: [{ parameters: ["i32"], results: ["i32"] }],
    functions: [{ typeIndex: 0, body: entry }],
    exports: [{ name: "countdown", functionIndex: 0 }]
  });
  const instance = await WebAssembly.instantiate(bytes);
  const countdown = exportedFunction(instance.instance, "countdown");

  strictEqual(countdown(100_000), 77);
});

function emitFunction(
  fn: FunctionBody,
  bindings: WasmFunctionBindings = unusedBindings
): EncodedWasmFunctionBody {
  return emitWasmFunctionBody(planWasmFunction(lowerWasmFunction(fn)), bindings);
}

async function instantiateSingle(
  type: WasmFunctionType,
  body: EncodedWasmFunctionBody,
  name: string
): Promise<(...args: number[]) => number> {
  const bytes = moduleBytes({
    types: [type],
    functions: [{ typeIndex: 0, body }],
    exports: [{ name, functionIndex: 0 }]
  });
  const instance = await WebAssembly.instantiate(bytes);

  return exportedFunction(instance.instance, name);
}

function exportedFunction(
  instance: WebAssembly.Instance,
  name: string
): (...args: number[]) => number {
  const exported = instance.exports[name];

  strictEqual(typeof exported, "function", `expected exported function ${name}`);
  return exported as (...args: number[]) => number;
}

function moduleBytes(
  description: Readonly<{
    types: readonly WasmFunctionType[];
    functions: readonly Readonly<{ typeIndex: number; body: EncodedWasmFunctionBody }>[];
    exports: readonly Readonly<{ name: string; functionIndex: number }>[];
    functionImports?: readonly WasmFunctionImport[];
    memoryImports?: readonly WasmMemoryImport[];
  }>
): Uint8Array<ArrayBuffer> {
  return encodeWasmModule({
    functionTypes: description.types,
    functionImports: description.functionImports ?? [],
    memoryImports: description.memoryImports ?? [],
    tableImports: [],
    functions: description.functions,
    globals: [],
    functionExports: description.exports
  });
}

function wordAccess(base: Integer<32>, displacement: number): ResourceAccess<32> {
  return {
    effect: effect(displacement),
    address: { base, displacement },
    storageWidth: 32,
    valueWidth: 32
  };
}

function effect(byteOffset: number): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "slice", origin: "resource", byteOffset, byteLength: 4 }
  };
}

function unexpectedBinding(): never {
  throw new Error("unexpected binding");
}

const unusedBindings: WasmFunctionBindings = {
  functionIndex: unexpectedBinding,
  memoryIndex: unexpectedBinding
};
