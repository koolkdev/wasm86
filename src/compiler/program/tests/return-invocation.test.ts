import {
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { resourceWrite } from "#compiler/ir/operations/resource.js";
import {
  resourceRef,
  type ResourceEffect
} from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import type { Program } from "#compiler/program/program.js";
import { compileProgram } from "#compiler/compile.js";
import { functionType } from "#compiler/ir/function.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef } from "#compiler/ir/refs.js";
import { createProgramResources } from "#compiler/program/resources.js";
import { FunctionBuilder } from "#compiler/ir/builder/function.js";

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
