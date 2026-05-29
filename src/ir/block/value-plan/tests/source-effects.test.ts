import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type {
  BlockDefinition,
  BlockDefinitionId
} from "#ir/block/definitions.js";
import type {
  BlockScheduleEntry,
  Placement
} from "#ir/block/schedule.js";
import { FlagState } from "#ir/block/state/flag-state.js";
import { RegisterState } from "#ir/block/state/register-state.js";
import { BlockState } from "#ir/block/walk/state.js";
import { opSite } from "#ir/block/walk/site.js";
import { sourceEffectsForSchedule } from "#ir/block/value-plan/source-effects.js";
import {
  exprConst
} from "#ir/expr/builders.js";
import type { ExprRef } from "#ir/expr/types.js";
import { registerAlias } from "#x86/registers.js";

test("changed state-sync register and flag cells produce source writes", () => {
  const entry = stateSyncEntry({ opIndex: 2, epoch: 0 }, BlockState.initial({
    registers: RegisterState.initial().write("eax", exprConst(0x11)),
    flags: FlagState.initial().apply({ cells: { ZF: { kind: "expr", value: exprConst(1) } } })
  }));

  deepStrictEqual(sourceEffectsForSchedule([entry]).map(effectSummary), [
    {
      kind: "write",
      order: 0,
      at: { opIndex: 2, epoch: 0 },
      source: { kind: "reg", reg: registerAlias("eax") }
    },
    {
      kind: "write",
      order: 0,
      at: { opIndex: 2, epoch: 0 },
      source: { kind: "flag", flag: "ZF" }
    }
  ]);
});

test("unchanged state-sync cells produce no writes", () => {
  const entry = stateSyncEntry({ opIndex: 1, epoch: 0 }, BlockState.initial());

  deepStrictEqual(sourceEffectsForSchedule([entry]), []);
});

test("dynamic-register store produces one register barrier", () => {
  const entry = dynamicRegisterStoreEntry({ opIndex: 3, epoch: 1 });
  const effects = sourceEffectsForSchedule([entry]);

  deepStrictEqual(effects.map(effectSummary), [
    {
      kind: "barrier",
      order: 0,
      at: { opIndex: 3, epoch: 1 },
      scope: "registers"
    }
  ]);
  strictEqual(effects[0]?.entry, entry);
});

test("definitions and ordinary actions do not produce source effects", () => {
  deepStrictEqual(
    sourceEffectsForSchedule([
      memoryLoadEntry({ opIndex: 0, epoch: 0 }),
      memoryStoreEntry({ opIndex: 1, epoch: 0 })
    ]),
    []
  );
});

test("source-effect extraction does not walk expressions", () => {
  const state = {
    registers: {
      cells: () => [
        { reg: "eax", value: expressionThatFailsIfWalked() }
      ]
    },
    flags: {
      cells: () => []
    }
  };
  const entry = {
    role: "boundary",
    kind: "stateSync",
    at: { opIndex: 4, epoch: 0 },
    state
  } as unknown as Extract<BlockScheduleEntry, { role: "boundary"; kind: "stateSync" }>;

  deepStrictEqual(sourceEffectsForSchedule([entry]).map(effectSummary), [
    {
      kind: "write",
      order: 0,
      at: { opIndex: 4, epoch: 0 },
      source: { kind: "reg", reg: registerAlias("eax") }
    }
  ]);
});

function stateSyncEntry(
  at: Placement,
  state: BlockState
): Extract<BlockScheduleEntry, { role: "boundary"; kind: "stateSync" }> {
  return Object.freeze({
    role: "boundary",
    kind: "stateSync",
    at,
    state
  });
}

function dynamicRegisterStoreEntry(
  at: Placement
): Extract<BlockScheduleEntry, { role: "action" }> {
  return Object.freeze({
    role: "action",
    at,
    action: Object.freeze({
      kind: "dynamicRegisterStore",
      at: opSite(at.opIndex),
      index: exprConst(0),
      value: exprConst(0x55),
      width: 32
    })
  });
}

function memoryStoreEntry(at: Placement): Extract<BlockScheduleEntry, { role: "action" }> {
  return Object.freeze({
    role: "action",
    at,
    action: Object.freeze({
      kind: "memoryStore",
      at: opSite(at.opIndex),
      address: exprConst(0x1000),
      value: exprConst(0x55),
      width: 32
    })
  });
}

function memoryLoadEntry(at: Placement): Extract<BlockScheduleEntry, { role: "definition" }> {
  const id = 0 as BlockDefinitionId;

  return Object.freeze({
    role: "definition",
    at,
    definition: Object.freeze({
      kind: "memoryLoad",
      id,
      at: opSite(at.opIndex),
      result: { kind: "def", id },
      address: exprConst(0x1000),
      width: 32
    } satisfies BlockDefinition)
  });
}

function effectSummary(effect: ReturnType<typeof sourceEffectsForSchedule>[number]): object {
  switch (effect.kind) {
    case "write":
      return {
        kind: effect.kind,
        order: effect.order,
        at: effect.at,
        source: effect.source
      };
    case "barrier":
      return {
        kind: effect.kind,
        order: effect.order,
        at: effect.at,
        scope: effect.scope
      };
  }
}

function expressionThatFailsIfWalked(): ExprRef {
  const fail = (): never => {
    throw new Error("source effects must not walk expressions");
  };

  return Object.freeze({
    kind: "binary",
    get op() {
      return fail();
    },
    get left() {
      return fail();
    },
    get right() {
      return fail();
    }
  }) as unknown as ExprRef;
}
