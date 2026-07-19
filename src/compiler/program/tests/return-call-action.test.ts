import {
  deepStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { resourceWrite } from "#compiler/ir/operations/resource.js";
import {
  resourceRef,
  type ResourceEffect
} from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { encodeProgram } from "#compiler/program/encode.js";
import { functionType } from "#compiler/program/function-type.js";
import {
  FunctionDefinition,
  FunctionFamily
} from "#compiler/program/functions.js";
import {
  exportRef,
  functionRef,
  signatureRef
} from "#compiler/program/refs.js";
import { FunctionBuilder } from "#ir/function.js";
import { actionCompletes } from "#ir/actions.js";
import { effectsOf } from "#ir/aliasing.js";
import { actionOperands } from "#ir/traverse.js";
import { validateIrFunction } from "#ir/validate.js";
import { emitFunction } from "#wasm/emit/action.js";

const noEffects = { reads: [], writes: [] } as const;
const effectResource = resourceRef("test.return-call-effect-resource");
const effect: ResourceEffect = {
  space: "resource",
  resource: effectResource,
  range: {
    basis: { kind: "resource" },
    slice: { byteOffset: 0, byteLength: 4 }
  }
};

function writeEffect(fn: FunctionBuilder, value: ValueId): void {
  fn.region.operation(resourceWrite.create({
    destination: {
      effect,
      address: { base: fn.values.const(0), displacement: 0 },
      width: 32
    },
    value
  }));
}

test("returnCall closes and emits a typed terminal tail call", async () => {
  const program = new ProgramBuilder();
  const type = functionType(["i32"], ["i32"]);
  const signature = signatureRef("test.return-call-action-signature");
  const family = new FunctionFamily<number>({
    type,
    effects: () => noEffects,
    id: (key) => `test.return-call-action-target-${key}`,
    build: (_key, fn) => {
      const argument = fn.parameters[0];

      if (argument === undefined) {
        throw new Error("missing tail-call target argument");
      }
      fn.return([argument]);
    }
  });
  const target = family.get(7);

  program.signature({ ref: signature, type });
  const caller = program.defineFunction({
    ref: functionRef("test.return-call-action-caller"),
    signature,
    effects: noEffects
  }, (fn) => {
    const argument = fn.parameters[0];

    if (argument === undefined) {
      throw new Error("missing tail-call argument");
    }
    fn.returnCall(target, [argument]);
  });
  program.exportFunction({
    ref: exportRef("test.return-call-action-export"),
    name: "entry",
    target: caller.ref
  });

  const closed = program.finish();
  const callerFunction = closed.functions.find((fn) => fn.ref === caller.ref);

  if (callerFunction === undefined || callerFunction.kind !== "function") {
    throw new Error("missing returnCall caller");
  }
  deepStrictEqual(callerFunction.callTargets, [target]);
  strictEqual(callerFunction.body.body.actions[0]?.kind, "returnCall");
  const emitted = emitFunction(callerFunction.body, {
    functionIndices: new Map([[target, 1]]),
    resourceIndices: new Map(),
    placement: callerFunction.placement
  });
  const opcodes = wasmBodyOpcodes(emitted.bytes);

  ok(opcodes.includes(wasmOpcode.returnCall));
  strictEqual(opcodes.includes(wasmOpcode.call), false);

  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeProgram(closed))
  );
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing returnCall entry");
  }
  strictEqual(entry(73), 73);
});

test("returnCall participates in declared-effect validation", () => {
  const program = new ProgramBuilder();
  const type = functionType(["i32"], []);
  const signature = signatureRef("test.return-call-effect-signature");
  const effects = {
    reads: [],
    writes: [effect]
  } as const;

  program.importMemory({
    ref: effectResource,
    moduleName: "test",
    name: "returnCallEffectResource",
    limits: { minPages: 1 }
  });
  program.signature({ ref: signature, type });
  const callee = program.defineFunction({
    ref: functionRef("test.return-call-effect-callee"),
    signature,
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
    signature,
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

  forged.region.push({
    kind: "returnCall",
    target: i64ResultTarget,
    arguments: []
  });
  throws(
    () => validateIrFunction(forged.finish()),
    /target results do not match the enclosing function/
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
  const action = valid.finish().body.actions[0];

  if (action === undefined) {
    throw new Error("missing valid returnCall action");
  }
  strictEqual(actionCompletes(action), true);
  deepStrictEqual(actionOperands(action), []);
  deepStrictEqual(effectsOf(action), noEffects);
});
