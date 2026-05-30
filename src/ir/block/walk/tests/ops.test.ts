import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import { FlagState } from "#ir/block/state/flag-state.js";
import { RegisterState } from "#ir/block/state/register-state.js";
import {
  blockProgress,
  BlockState
} from "#ir/block/walk/index.js";
import {
  exprBinary,
  exprConst
} from "#ir/expr/builders.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import { ControlWalkOps } from "../control-ops.js";
import { DynamicRegisterWalkOps } from "../dynamic-register-ops.js";
import { FlagWalkOps } from "../flag-ops.js";
import { MemoryWalkOps } from "../memory-ops.js";
import { BlockWalkRecorder } from "../recorder.js";
import { RegisterAccessValidator } from "../register-access-validator.js";
import { RegisterWalkState } from "../registers.js";
import type { BlockAction } from "#ir/block/actions.js";
import type { BlockDefinition } from "#ir/block/definitions.js";
import { opSite } from "../site.js";
import { StorageWalkOps } from "../storage-ops.js";
import { ValueWalkOps } from "../value-ops.js";

test("StorageWalkOps dispatches dynamic register storage through dynamic ops", () => {
  const harness = storageHarness(new BindingResolver({
    operands: [dynamicRegBinding(exprConst(2), 32)]
  }));
  const loaded = harness.storage.read({ kind: "operand", index: 0 }, 32);

  harness.storage.write({ kind: "operand", index: 0 }, loaded, 32);

  const result = harness.result();
  const definitions = definitionsOf(result.schedule);
  const actions = actionsOf(result.schedule);

  strictEqual(definitions.length, 1);
  strictEqual(definitions[0]?.kind, "dynamicRegisterLoad");
  strictEqual(actions.length, 1);
  strictEqual(actions[0]?.kind, "dynamicRegisterStore");
});

test("ControlWalkOps records branch continuation and shared snapshots", () => {
  let site = opSite(3);
  const recorder = new BlockWalkRecorder();
  const snapshot = BlockState.initial({ progress: blockProgress(3, "before") });
  const control = new ControlWalkOps({
    recorder,
    site: () => site,
    snapshot: () => snapshot,
    continuation: exprConst(0x44),
    value: constValue
  });

  control.branch(exprConst(1), exprConst(0x40), { kind: "nextEip" });

  const result = recorder.result(snapshot);
  const action = onlyAction(actionsOf(result.schedule));

  strictEqual(action.kind, "branch");
  if (action.kind === "branch") {
    deepStrictEqual(action.continuation, { kind: "continuation", value: exprConst(0x44) });
    strictEqual(action.taken.snapshot, snapshot);
    strictEqual(action.notTaken.snapshot, snapshot);
  }

  site = opSite(4);
  control.fallthrough();
  strictEqual(actionsOf(recorder.result(snapshot).schedule).length, 2);
});

test("FlagWalkOps lowers flag writes and reports undefined conditions with op index", () => {
  let opIndex = 7;
  const flags = new FlagWalkOps({
    flags: FlagState.initial(),
    value: constValue,
    opIndex: () => opIndex
  });

  flags.write({
    op: "flags.write",
    cells: {
      ZF: { kind: "expr", value: c(1) }
    },
    conditions: {
      E: c(2)
    }
  });

  deepStrictEqual(flags.condition("E"), exprConst(2));

  const emptyFlags = new FlagWalkOps({
    flags: FlagState.initial().apply({ cells: { ZF: { kind: "undef" } } }),
    value: constValue,
    opIndex: () => opIndex
  });
  opIndex = 8;
  throws(() => emptyFlags.condition("NE"), /condition NE depends on undefined flags at op 8/);
});

test("ValueWalkOps owns pure value expression lowering", () => {
  const values = new ValueWalkOps({
    values: undefined,
    value: undefined,
    opIndex: () => 0
  });

  values.bind(v(0), values.binary("add", c(1), c(2)));

  deepStrictEqual(
    values.resolve(v(0)),
    canonicalizeExpr(exprBinary("add", exprConst(1), exprConst(2)))
  );
});

function storageHarness(resolver: BindingResolver): Readonly<{
  storage: StorageWalkOps;
  result: () => ReturnType<BlockWalkRecorder["result"]>;
}> {
  const recorder = new BlockWalkRecorder();
  const registerValidator = new RegisterAccessValidator();
  const registers = new RegisterWalkState({
    registers: RegisterState.initial(),
    site: () => opSite(0),
    validator: registerValidator
  });
  const dynamic = new DynamicRegisterWalkOps({
    recorder,
    registers,
    validator: registerValidator,
    site: () => opSite(0),
    snapshot: () => BlockState.initial({ registers: registers.state })
  });
  const memory = new MemoryWalkOps({
    recorder,
    site: () => opSite(0),
    snapshot: () => BlockState.initial({ registers: registers.state })
  });
  const storage = new StorageWalkOps({
    resolver,
    registers,
    dynamic,
    memory,
    value: constValue
  });

  return Object.freeze({
    storage,
    result: () => recorder.result(BlockState.initial({ registers: registers.state }))
  });
}

function actionsOf(schedule: ReturnType<BlockWalkRecorder["result"]>["schedule"]): readonly BlockAction[] {
  return schedule.flatMap((entry) => entry.role === "action" ? [entry.action] : []);
}

function definitionsOf(schedule: ReturnType<BlockWalkRecorder["result"]>["schedule"]): readonly BlockDefinition[] {
  return schedule.flatMap((entry) => entry.role === "definition" ? [entry.definition] : []);
}

function onlyAction(actions: readonly BlockAction[]): BlockAction {
  strictEqual(actions.length, 1);
  return actions[0]!;
}

function constValue(value: ValueRef): ExprRef {
  if (value.kind !== "const") {
    throw new Error(`unexpected non-const value ${value.kind}`);
  }

  return exprConst(value.value);
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
