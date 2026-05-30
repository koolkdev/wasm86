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
  BlockActionSite,
  BlockBoundarySite,
  BlockDefinitionSite,
  Placement
} from "#ir/block/timeline.js";
import { FlagState } from "#ir/block/state/flag-state.js";
import { RegisterState } from "#ir/block/state/register-state.js";
import { BlockState } from "#ir/block/walk/state.js";
import { opSite } from "#ir/block/walk/site.js";
import { sourceEffectsForBlockSites } from "#ir/block/value-plan/source-effects.js";
import {
  exprConst
} from "#ir/expr/builders.js";
import type { ExprRef } from "#ir/expr/types.js";
import { registerAlias } from "#x86/registers.js";

test("changed state-sync register and flag cells produce source writes", () => {
  const site = stateSyncSite({ opIndex: 2, epoch: 0 }, BlockState.initial({
    registers: RegisterState.initial().write("eax", exprConst(0x11)),
    flags: FlagState.initial().apply({ cells: { ZF: { kind: "expr", value: exprConst(1) } } })
  }));

  deepStrictEqual(sourceEffectsForBlockSites({ timeline: [site] }).map(effectSummary), [
    {
      kind: "write",
      at: { opIndex: 2, epoch: 0 },
      source: { kind: "reg", reg: registerAlias("eax") }
    },
    {
      kind: "write",
      at: { opIndex: 2, epoch: 0 },
      source: { kind: "flag", flag: "ZF" }
    }
  ]);
});

test("unchanged state-sync cells produce no writes", () => {
  const site = stateSyncSite({ opIndex: 1, epoch: 0 }, BlockState.initial());

  deepStrictEqual(sourceEffectsForBlockSites({ timeline: [site] }), []);
});

test("dynamic-register store produces one register barrier", () => {
  const site = dynamicRegisterStoreSite({ opIndex: 3, epoch: 1 });
  const [effect] = sourceEffectsForBlockSites({ timeline: [site] });

  deepStrictEqual(effect === undefined ? [] : [effectSummary(effect)], [
    {
      kind: "barrier",
      at: { opIndex: 3, epoch: 1 },
      scope: "registers"
    }
  ]);
  strictEqual(effect?.site, site);
});

test("definitions and ordinary actions do not produce source effects", () => {
  deepStrictEqual(
    sourceEffectsForBlockSites({
      timeline: [
        memoryLoadSite({ opIndex: 0, epoch: 0 }),
        memoryStoreSite({ opIndex: 1, epoch: 0 })
      ]
    }),
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
  const site = {
    kind: "boundary",
    at: { opIndex: 4, epoch: 0 },
    boundary: {
      kind: "stateSync",
      state
    }
  } as unknown as BlockBoundarySite;

  deepStrictEqual(sourceEffectsForBlockSites({ timeline: [site] }).map(effectSummary), [
    {
      kind: "write",
      at: { opIndex: 4, epoch: 0 },
      source: { kind: "reg", reg: registerAlias("eax") }
    }
  ]);
});

function stateSyncSite(
  at: Placement,
  state: BlockState
): BlockBoundarySite & Readonly<{
  boundary: Readonly<{ kind: "stateSync"; state: BlockState }>;
}> {
  return Object.freeze({
    kind: "boundary",
    at,
    boundary: Object.freeze({
      kind: "stateSync",
      state
    })
  });
}

function dynamicRegisterStoreSite(
  at: Placement
): BlockActionSite {
  return Object.freeze({
    kind: "action",
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

function memoryStoreSite(at: Placement): BlockActionSite {
  return Object.freeze({
    kind: "action",
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

function memoryLoadSite(at: Placement): BlockDefinitionSite {
  const id = 0 as BlockDefinitionId;

  return Object.freeze({
    kind: "definition",
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

function effectSummary(effect: ReturnType<typeof sourceEffectsForBlockSites>[number]): object {
  switch (effect.kind) {
    case "write":
      return {
        kind: effect.kind,
        at: effect.at,
        source: effect.source
      };
    case "barrier":
      return {
        kind: effect.kind,
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
