import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type {
  ExprRecipe,
  ExprRecipeId,
  PlannedStateWrite,
  StateObligationId,
  StateWriteId
} from "#ir/block/planning/index.js";
import type { ProgramPoint } from "#ir/block/planning/geometry/index.js";
import type { StateTarget } from "#ir/block/state/targets.js";
import { exprConst } from "#ir/expr/builders.js";
import type { WasmTargetStorage } from "#wasm/emit/targets/storage.js";
import { createWasmStateWriteEmitter } from "#wasm/emit/block/state-writes.js";
import {
  wasmI32
} from "#wasm/emit/values/types.js";
import { registerAlias } from "#x86/registers.js";

test("state-write emission stores the representative planned write through target storage", () => {
  const events: string[] = [];
  const write = plannedWrite(0, { kind: "reg", reg: registerAlias("eax") }, exprRecipe(0x1234));
  const covered = plannedWrite(1, { kind: "reg", reg: registerAlias("eax") }, exprRecipe(0x1234));
  const storage: WasmTargetStorage = {
    emitLoad: () => fail("state-write emission should not load target storage"),
    emitStore: (target, emitValue) => {
      events.push(`store:${target.kind}:${target.kind === "reg" ? target.reg.base : target.flag}`);
      emitValue();
    }
  };
  const emitter = createWasmStateWriteEmitter({ storage });

  emitter.emitStateWrite({
    write,
    satisfies: [write, covered],
    emitValue: () => {
      events.push("value");
      return wasmI32(32);
    }
  });

  deepStrictEqual(events, ["store:reg:eax", "value"]);
});

test("undefined flag state-write remains a no-op when no value recipe exists", () => {
  const events: string[] = [];
  const write = plannedWrite(0, { kind: "flag", flag: "ZF" }, undefined);
  const emitter = createWasmStateWriteEmitter({
    storage: {
      emitLoad: () => fail("undefined state write should not load"),
      emitStore: () => events.push("store")
    }
  });

  emitter.emitStateWrite({
    write,
    satisfies: [write],
    emitValue: () => fail("undefined state write should not emit a value")
  });

  deepStrictEqual(events, []);
});

function plannedWrite(
  id: number,
  target: StateTarget,
  value: ExprRecipe | undefined
): PlannedStateWrite {
  return Object.freeze({
    id: id as StateWriteId,
    obligation: id as StateObligationId,
    point: point(),
    target,
    value,
    valueRecipeId: value === undefined ? undefined : id as ExprRecipeId,
    reason: "exit-state"
  } satisfies PlannedStateWrite);
}

function exprRecipe(value: number): ExprRecipe {
  return Object.freeze({
    kind: "expr",
    expr: exprConst(value),
    children: Object.freeze([])
  });
}

function point(): ProgramPoint {
  return Object.freeze({
    path: Object.freeze({ kind: "main" }),
    at: Object.freeze({ opIndex: 0, epoch: 0 }),
    phase: "at"
  });
}

function fail(message: string): never {
  throw new Error(message);
}
