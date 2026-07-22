import {
  deepStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { Invocation } from "#compiler/ir/invocation.js";
import { resourceWrite } from "#compiler/ir/operations/resource.js";
import { returnControl } from "#compiler/ir/controls/index.js";
import {
  resourceRef,
  type ResourceEffect
} from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import { compileProgram } from "#compiler/program/compile.js";
import { createModuleBindings } from "#compiler/program/bindings.js";
import { functionType } from "#compiler/program/function-type.js";
import {
  FunctionDefinition,
  FunctionFamily
} from "#compiler/program/functions.js";
import {
  functionExportRef,
  functionRef
} from "#compiler/program/refs.js";
import { createProgramResources } from "#compiler/program/resources.js";
import { FunctionBuilder } from "#ir/function.js";
import { nodeCompletes } from "#ir/block.js";
import { effectsOf } from "#ir/aliasing.js";
import { validateIrFunction } from "#ir/validate.js";
import { emitFunction } from "#wasm/emit/action.js";

const noEffects = { reads: [], writes: [] } as const;
const effectResource = resourceRef("test.return-call-effect-resource");
const returnInvocationResources = createProgramResources([
  {
    ref: effectResource,
    moduleName: "test",
    name: "returnCallEffectResource",
    limits: { minPages: 1 }
  }
]);
const effect: ResourceEffect = {
  space: "resource",
  resource: effectResource,
  range: {
    basis: { kind: "resource" },
    slice: { byteOffset: 0, byteLength: 4 }
  }
};

function createTestProgram(): ProgramBuilder {
  return new ProgramBuilder(returnInvocationResources);
}

function compileBytes(program: Program): Uint8Array<ArrayBuffer> {
  return compileProgram(program).bytes;
}

function writeEffect(fn: FunctionBuilder, value: ValueId): void {
  fn.region.operation(resourceWrite, {
    destination: {
      effect,
      address: { base: fn.values.const(0), displacement: 0 },
      width: 32
    },
    value
  });
}

test("returned direct invocations keep deep recursion on a bounded stack", async () => {
  const program = createTestProgram();
  const type = functionType(["i32"], []);

  const countdown = program.defineFunction({
    ref: functionRef("test.deep-return-invocation-countdown"),
    type,
    effects: noEffects
  }, (fn, self) => {
    const remaining = fn.parameters[0];

    if (remaining === undefined) {
      throw new Error("missing countdown argument");
    }
    fn.region.if(
      remaining,
      (thenBody) => {
        thenBody.returnCall(self, [
          fn.values.binary("sub", remaining, fn.values.const(1))
        ]);
      },
      {
        elseBuild: (elseBody) => {
          elseBody.return([]);
        }
      }
    );
  });
  program.exportFunction({
    ref: functionExportRef("test.deep-return-invocation-export"),
    name: "entry",
    target: countdown.ref
  });

  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(compileBytes(program.finish()))
  );
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing deep return-invocation entry");
  }
  strictEqual(entry(100_000), undefined);
});

test("returnCall closes and emits a typed terminal tail call", async () => {
  const program = createTestProgram();
  const type = functionType(["i32"], ["i32"]);
  const family = new FunctionFamily<number>({
    type,
    effects: () => noEffects,
    id: (key) => `test.return-call-control-target-${key}`,
    build: (_key, fn) => {
      const argument = fn.parameters[0];

      if (argument === undefined) {
        throw new Error("missing tail-call target argument");
      }
      fn.return([argument]);
    }
  });
  const target = family.get(7);

  const caller = program.defineFunction({
    ref: functionRef("test.return-call-control-caller"),
    type,
    effects: noEffects
  }, (fn) => {
    const argument = fn.parameters[0];

    if (argument === undefined) {
      throw new Error("missing tail-call argument");
    }
    fn.returnCall(target, [argument]);
  });
  program.exportFunction({
    ref: functionExportRef("test.return-call-control-export"),
    name: "entry",
    target: caller.ref
  });

  const closed = program.finish();
  const callerFunction = closed.functions.find((fn) => fn.ref === caller.ref);

  if (callerFunction === undefined || callerFunction.kind !== "function") {
    throw new Error("missing returnCall caller");
  }
  deepStrictEqual(callerFunction.directTargets, [target]);
  strictEqual(callerFunction.body.body.nodes[0]?.kind, "return");
  const emitted = emitFunction(callerFunction.body, {
    bindings: createModuleBindings({
      functions: new Map([[target.ref, 1]]),
      types: new Map(),
      tables: new Map(),
      resources: new Map()
    }),
    placement: callerFunction.placement
  });
  const opcodes = wasmBodyOpcodes(emitted.bytes);

  ok(opcodes.includes(wasmOpcode.returnCall));
  strictEqual(opcodes.includes(wasmOpcode.call), false);

  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(compileBytes(closed))
  );
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing returnCall entry");
  }
  strictEqual(entry(73), 73);
});

test("returnCall participates in declared-effect validation", () => {
  const program = createTestProgram();
  const type = functionType(["i32"], []);
  const effects = {
    reads: [],
    writes: [effect]
  } as const;

  const callee = program.defineFunction({
    ref: functionRef("test.return-call-effect-callee"),
    type,
    effects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing effectful callee argument");
    }
    writeEffect(fn, value);
    fn.return([]);
  });
  program.defineFunction({
    ref: functionRef("test.return-call-effect-caller"),
    type,
    effects: noEffects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing effectful tail-call argument");
    }
    fn.returnCall(callee, [value]);
  });

  throws(
    () => program.finish(),
    /return-call-effect-caller.*undeclared write effect/
  );
});

test("returnCall enforces argument and enclosing-result types", () => {
  const i32Result = functionType([], ["i32"]);
  const i64ResultTarget = new FunctionDefinition({
    ref: functionRef("test.return-call-i64-result"),
    type: functionType([], ["i64"]),
    effects: noEffects,
    owner: undefined,
    build: () => {}
  });
  const i64ArgumentTarget = new FunctionDefinition({
    ref: functionRef("test.return-call-i64-argument"),
    type: functionType(["i64"], ["i32"]),
    effects: noEffects,
    owner: undefined,
    build: () => {}
  });
  const fn = new FunctionBuilder(i32Result);

  throws(
    () => fn.returnCall(i64ResultTarget, []),
    /results do not match the enclosing function/
  );
  throws(
    () => fn.returnCall(i64ArgumentTarget, [fn.values.const(1)]),
    /argument 0 must be i64, got i32/
  );

  const forged = new FunctionBuilder(i32Result);

  forged.region.push(returnControl.create({
    source: {
      kind: "invocation",
      invocation: Invocation.create({
        target: i64ResultTarget,
        arguments: []
      })
    }
  }));
  throws(
    () => validateIrFunction(forged.finish()),
    /invocation results do not match the enclosing function/
  );

  const validTarget = new FunctionDefinition({
    ref: functionRef("test.return-call-valid-target"),
    type: i32Result,
    effects: noEffects,
    owner: undefined,
    build: () => {}
  });
  const valid = new FunctionBuilder(i32Result);

  valid.returnCall(validTarget, []);
  const control = valid.finish().body.nodes[0];

  if (control === undefined) {
    throw new Error("missing valid returnCall control");
  }
  strictEqual(nodeCompletes(control), true);
  deepStrictEqual(control.operands, []);
  deepStrictEqual(effectsOf(control), noEffects);
});
