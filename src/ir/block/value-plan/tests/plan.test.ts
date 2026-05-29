import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type { BlockAction } from "#ir/block/actions.js";
import type {
  BlockDefinition,
  BlockDefinitionId
} from "#ir/block/definitions.js";
import {
  rootsForSchedule
} from "#ir/block/roots.js";
import type {
  BlockScheduleEntry,
  BlockScheduleEntryIndex,
  Placement
} from "#ir/block/schedule.js";
import {
  sourceCellForFlag,
  sourceCellForRegisterAlias,
  type SourceCell
} from "#ir/block/source-cells.js";
import { RegisterState } from "#ir/block/state/register-state.js";
import { BlockState } from "#ir/block/walk/state.js";
import { opSite } from "#ir/block/walk/site.js";
import {
  exprConst,
  exprInput
} from "#ir/expr/builders.js";
import { buildExprGraph } from "#ir/expr/graph/index.js";
import type { ExprRef } from "#ir/expr/types.js";
import { registerAlias } from "#x86/registers.js";
import {
  planBlockValues
} from "#ir/block/value-plan/plan.js";
import type { ProducedValue } from "#ir/block/value-plan/produced-values.js";
import type { SourceEffect } from "#ir/block/value-plan/source-effects.js";
import {
  valueSitesForRoots,
  type ValueSite,
  type ValueSiteInput
} from "#ir/block/value-plan/value-sites.js";

test("repeated sites with the same graph key produce one planned value", () => {
  const left = valueSite({ key: 7, entryIndex: 1 });
  const right = valueSite({ key: 7, entryIndex: 4 });
  const plan = planBlockValues({
    sites: [left, right],
    producedValues: [],
    sourceEffects: []
  });

  strictEqual(plan.values.length, 1);
  deepStrictEqual(plan.values[0]?.sites, [left, right]);
  deepStrictEqual(plan.values[0]?.lifetime, {
    firstEntry: 1,
    lastEntry: 4
  });
});

test("duplicate sites at the same entry are preserved", () => {
  const site = valueSite({ key: 3, entryIndex: 2 });
  const duplicate = valueSite({ key: 3, entryIndex: 2 });
  const plan = planBlockValues({
    sites: [site, duplicate],
    producedValues: [],
    sourceEffects: []
  });

  strictEqual(plan.values[0]?.sites.length, 2);
  strictEqual(plan.values[0]?.sites[0], site);
  strictEqual(plan.values[0]?.sites[1], duplicate);
  deepStrictEqual(plan.values[0]?.lifetime, {
    firstEntry: 2,
    lastEntry: 2
  });
});

test("source effects do not split planned values by themselves", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const plan = planBlockValues({
    sites: [
      valueSite({ key: 1, entryIndex: 0, sourceCells: [source] }),
      valueSite({ key: 1, entryIndex: 3, sourceCells: [source] })
    ],
    producedValues: [],
    sourceEffects: [sourceWrite(1, source)]
  });

  strictEqual(plan.values.length, 1);
  strictEqual(plan.captures.length, 0);
});

test("source write before first site creates a capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const effect = sourceWrite(1, source);
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, entryIndex: 2, sourceCells: [source] })],
    producedValues: [],
    sourceEffects: [effect]
  });
  const value = plan.values[0];
  const capture = plan.captures[0];

  strictEqual(plan.captures.length, 1);
  strictEqual(capture?.value, value?.id);
  deepStrictEqual(capture?.source, source);
  strictEqual(capture?.before, effect);
  strictEqual(capture?.entryIndex, 1);
});

test("source write at first site entry does not create a capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, entryIndex: 2, sourceCells: [source] })],
    producedValues: [],
    sourceEffects: [sourceWrite(2, source)]
  });

  strictEqual(plan.captures.length, 0);
});

test("source write after first site does not create a capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, entryIndex: 2, sourceCells: [source] })],
    producedValues: [],
    sourceEffects: [sourceWrite(3, source)]
  });

  strictEqual(plan.captures.length, 0);
});

test("register barrier before first site captures register-backed values", () => {
  const regSource = sourceCellForRegisterAlias(registerAlias("eax"));
  const flagSource = sourceCellForFlag("ZF");
  const plan = planBlockValues({
    sites: [
      valueSite({ key: 1, entryIndex: 2, sourceCells: [regSource] }),
      valueSite({ key: 2, entryIndex: 2, sourceCells: [flagSource] })
    ],
    producedValues: [],
    sourceEffects: [registerBarrier(1)]
  });

  deepStrictEqual(plan.captures.map((capture) => capture.source), [regSource]);
});

test("flag writes capture the same flag source once before first site", () => {
  const source = sourceCellForFlag("ZF");
  const firstWrite = sourceWrite(1, source);
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, entryIndex: 3, sourceCells: [source] })],
    producedValues: [],
    sourceEffects: [
      firstWrite,
      sourceWrite(2, source),
      sourceWrite(2, sourceCellForFlag("CF"))
    ]
  });

  strictEqual(plan.captures.length, 1);
  deepStrictEqual(plan.captures[0]?.source, source);
  strictEqual(plan.captures[0]?.before, firstWrite);
});

test("non-overlapping alias write does not capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("ah"));
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, entryIndex: 2, sourceCells: [source] })],
    producedValues: [],
    sourceEffects: [sourceWrite(1, sourceCellForRegisterAlias(registerAlias("al")))]
  });

  strictEqual(plan.captures.length, 0);
});

test("mixed al and eax sites merge source cells to eax", () => {
  const plan = planBlockValues({
    sites: [
      valueSite({
        key: 1,
        entryIndex: 1,
        sourceCells: [sourceCellForRegisterAlias(registerAlias("al"))]
      }),
      valueSite({
        key: 1,
        entryIndex: 3,
        sourceCells: [sourceCellForRegisterAlias(registerAlias("eax"))]
      })
    ],
    producedValues: [],
    sourceEffects: []
  });

  deepStrictEqual(plan.values[0]?.deps.sourceCells, [
    sourceCellForRegisterAlias(registerAlias("eax"))
  ]);
});

test("produced value consumers are found through definitionIds", () => {
  const id = 4 as BlockDefinitionId;
  const produced = producedValue(id, 1);
  const consumer = valueSite({ key: 1, entryIndex: 5, definitionIds: [id] });
  const plan = planBlockValues({
    sites: [consumer],
    producedValues: [produced],
    sourceEffects: []
  });

  deepStrictEqual(plan.produced.map((entry) => ({
    produced: entry.produced,
    consumers: entry.consumers,
    lifetime: entry.lifetime
  })), [
    {
      produced,
      consumers: [consumer],
      lifetime: {
        firstEntry: 1,
        lastEntry: 5
      }
    }
  ]);
});

test("produced values do not receive source captures", () => {
  const id = 8 as BlockDefinitionId;
  const produced = producedValue(id, 0);
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, entryIndex: 3, definitionIds: [id] })],
    producedValues: [produced],
    sourceEffects: [sourceWrite(1, sourceCellForRegisterAlias(registerAlias("eax")))]
  });

  strictEqual(plan.captures.length, 0);
  strictEqual(Object.hasOwn(plan.produced[0]!, "captures"), false);
});

test("boundary views contain only non-passthrough boundary sites", () => {
  const entry = stateSyncEntry({ opIndex: 3, epoch: 0 }, BlockState.initial({
    registers: RegisterState.initial().write("eax", exprConst(0x11))
  }));
  const sites = valueSitesForRoots(valueSiteInput([entry]));
  const plan = planBlockValues({
    sites,
    producedValues: [],
    sourceEffects: []
  });

  strictEqual(sites.length, 1);
  deepStrictEqual(plan.boundaries.map((boundary) => ({
    boundary: boundary.boundary,
    entryIndex: boundary.entryIndex,
    at: boundary.at,
    sites: boundary.sites.map((site) => site.cell)
  })), [
    {
      boundary: "stateSync",
      entryIndex: 0,
      at: { opIndex: 3, epoch: 0 },
      sites: [{ kind: "reg", reg: "eax" }]
    }
  ]);
});

function valueSite(input: {
  key: number;
  entryIndex: number;
  expr?: ExprRef;
  sourceCells?: readonly SourceCell[];
  definitionIds?: readonly BlockDefinitionId[];
}): ValueSite {
  const entryIndex = input.entryIndex as BlockScheduleEntryIndex;
  const at = { opIndex: input.entryIndex, epoch: 0 };
  const expr = input.expr ?? exprInput({ kind: "reg", reg: "eax" });
  const entry = memoryStoreEntry(at, expr);
  const root = Object.freeze({
    expr,
    at,
    purpose: Object.freeze({ kind: "actionInput", input: "value" }),
    entry
  });

  return Object.freeze({
    kind: "actionInput",
    key: input.key,
    expr,
    root,
    entryIndex,
    at,
    deps: Object.freeze({
      sourceCells: Object.freeze([...(input.sourceCells ?? [])]),
      definitionIds: Object.freeze([...(input.definitionIds ?? [])])
    }),
    entry,
    input: "value"
  });
}

function valueSiteInput(
  schedule: readonly BlockScheduleEntry[]
): ValueSiteInput {
  const roots = rootsForSchedule(schedule);

  return {
    schedule,
    graph: buildExprGraph(roots.map((root) => root.expr)),
    roots
  };
}

function producedValue(id: BlockDefinitionId, index: number): ProducedValue {
  const at = { opIndex: index, epoch: 0 };
  const entry = memoryLoadEntry(at, id);

  return Object.freeze({
    id,
    entryIndex: index as BlockScheduleEntryIndex,
    at,
    entry
  });
}

function sourceWrite(index: number, source: SourceCell): SourceEffect {
  const at = { opIndex: index, epoch: 0 };

  return Object.freeze({
    kind: "write",
    entryIndex: index as BlockScheduleEntryIndex,
    at,
    source,
    entry: stateSyncEntry(at, BlockState.initial())
  });
}

function registerBarrier(index: number): SourceEffect {
  const at = { opIndex: index, epoch: 0 };

  return Object.freeze({
    kind: "barrier",
    entryIndex: index as BlockScheduleEntryIndex,
    at,
    scope: "registers",
    entry: dynamicRegisterStoreEntry(at)
  });
}

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

function memoryLoadEntry(
  at: Placement,
  id: BlockDefinitionId
): Extract<BlockScheduleEntry, { role: "definition" }> &
  Readonly<{ definition: Extract<BlockDefinition, { kind: "memoryLoad" }> }> {
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
    } satisfies Extract<BlockDefinition, { kind: "memoryLoad" }>)
  });
}

function memoryStoreEntry(
  at: Placement,
  value: ExprRef
): Extract<BlockScheduleEntry, { role: "action" }> &
  Readonly<{ action: Extract<BlockAction, { kind: "memoryStore" }> }> {
  return Object.freeze({
    role: "action",
    at,
    action: Object.freeze({
      kind: "memoryStore",
      at: opSite(at.opIndex),
      address: exprConst(0x2000),
      value,
      width: 32
    } satisfies Extract<BlockAction, { kind: "memoryStore" }>)
  });
}

function dynamicRegisterStoreEntry(
  at: Placement
): Extract<BlockScheduleEntry, { role: "action" }> &
  Readonly<{ action: Extract<BlockAction, { kind: "dynamicRegisterStore" }> }> {
  return Object.freeze({
    role: "action",
    at,
    action: Object.freeze({
      kind: "dynamicRegisterStore",
      at: opSite(at.opIndex),
      index: exprConst(0),
      value: exprConst(0x55),
      width: 32
    } satisfies Extract<BlockAction, { kind: "dynamicRegisterStore" }>)
  });
}
