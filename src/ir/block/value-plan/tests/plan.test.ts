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
  rootsForBlockSites
} from "#ir/block/roots.js";
import type {
  BlockActionSite,
  BlockBoundarySite,
  BlockDefinitionSite,
  BlockTimelineSite,
  Placement
} from "#ir/block/timeline.js";
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
  const left = valueSite({ key: 7, opIndex: 1 });
  const right = valueSite({ key: 7, opIndex: 4 });
  const plan = planBlockValues({
    sites: [left, right],
    producedValues: [],
    sourceEffects: []
  });

  strictEqual(plan.values.length, 1);
  deepStrictEqual(plan.values[0]?.sites, [left, right]);
  deepStrictEqual(plan.values[0]?.lifetime, {
    start: { opIndex: 1, epoch: 0 },
    end: { opIndex: 4, epoch: 0 }
  });
});

test("duplicate sites at the same placement are preserved", () => {
  const site = valueSite({ key: 3, opIndex: 2 });
  const duplicate = valueSite({ key: 3, opIndex: 2 });
  const plan = planBlockValues({
    sites: [site, duplicate],
    producedValues: [],
    sourceEffects: []
  });

  strictEqual(plan.values[0]?.sites.length, 2);
  strictEqual(plan.values[0]?.sites[0], site);
  strictEqual(plan.values[0]?.sites[1], duplicate);
  deepStrictEqual(plan.values[0]?.lifetime, {
    start: { opIndex: 2, epoch: 0 },
    end: { opIndex: 2, epoch: 0 }
  });
});

test("source effects do not split planned values by themselves", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const plan = planBlockValues({
    sites: [
      valueSite({ key: 1, opIndex: 0, sourceCells: [source] }),
      valueSite({ key: 1, opIndex: 3, sourceCells: [source] })
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
    sites: [valueSite({ key: 1, opIndex: 2, sourceCells: [source] })],
    producedValues: [],
    sourceEffects: [effect]
  });
  const value = plan.values[0];
  const capture = plan.captures[0];

  strictEqual(plan.captures.length, 1);
  strictEqual(capture?.value, value?.id);
  deepStrictEqual(capture?.source, source);
  strictEqual(capture?.before, effect);
  deepStrictEqual(capture?.at, { opIndex: 1, epoch: 0 });
});

test("source captures use the first required placement before first site", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const firstWrite = sourceWrite(1, source);
  const laterWrite = sourceWrite(2, source);
  const afterFirstSite = sourceWrite(4, source);
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, opIndex: 3, sourceCells: [source] })],
    producedValues: [],
    sourceEffects: [
      firstWrite,
      laterWrite,
      afterFirstSite
    ]
  });

  strictEqual(plan.captures.length, 1);
  strictEqual(plan.captures[0]?.before, firstWrite);
  deepStrictEqual(plan.captures[0]?.at, { opIndex: 1, epoch: 0 });
});

test("source write at first site placement does not create a capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, opIndex: 2, sourceCells: [source] })],
    producedValues: [],
    sourceEffects: [sourceWrite(2, source)]
  });

  strictEqual(plan.captures.length, 0);
});

test("source write after first site does not create a capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, opIndex: 2, sourceCells: [source] })],
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
      valueSite({ key: 1, opIndex: 2, sourceCells: [regSource] }),
      valueSite({ key: 2, opIndex: 2, sourceCells: [flagSource] })
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
    sites: [valueSite({ key: 1, opIndex: 3, sourceCells: [source] })],
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

test("first source capture for a value removes all remaining source waits", () => {
  const eax = sourceCellForRegisterAlias(registerAlias("eax"));
  const ebx = sourceCellForRegisterAlias(registerAlias("ebx"));
  const firstWrite = sourceWrite(1, eax);
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, opIndex: 4, sourceCells: [eax, ebx] })],
    producedValues: [],
    sourceEffects: [
      firstWrite,
      sourceWrite(2, ebx)
    ]
  });

  strictEqual(plan.captures.length, 1);
  strictEqual(plan.captures[0]?.before, firstWrite);
});

test("non-overlapping alias write does not capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("ah"));
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, opIndex: 2, sourceCells: [source] })],
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
        opIndex: 1,
        sourceCells: [sourceCellForRegisterAlias(registerAlias("al"))]
      }),
      valueSite({
        key: 1,
        opIndex: 3,
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
  const unusedId = 5 as BlockDefinitionId;
  const produced = producedValue(id, 1);
  const unusedProduced = producedValue(unusedId, 2);
  const consumer = valueSite({ key: 1, opIndex: 5, definitionIds: [id] });
  const plan = planBlockValues({
    sites: [consumer],
    producedValues: [produced, unusedProduced],
    sourceEffects: []
  });

  strictEqual(plan.produced.length, 1);
  deepStrictEqual(plan.produced.map((planned) => ({
    produced: planned.produced,
    consumers: planned.consumers,
    lifetime: planned.lifetime
  })), [
    {
      produced,
      consumers: [consumer],
      lifetime: {
        start: { opIndex: 1, epoch: 0 },
        end: { opIndex: 5, epoch: 0 }
      }
    }
  ]);
});

test("produced values do not receive source captures", () => {
  const id = 8 as BlockDefinitionId;
  const produced = producedValue(id, 0);
  const plan = planBlockValues({
    sites: [valueSite({ key: 1, opIndex: 3, definitionIds: [id] })],
    producedValues: [produced],
    sourceEffects: [sourceWrite(1, sourceCellForRegisterAlias(registerAlias("eax")))]
  });

  strictEqual(plan.captures.length, 0);
  strictEqual(Object.hasOwn(plan.produced[0]!, "captures"), false);
});

test("boundary views contain only non-passthrough boundary sites", () => {
  const site = stateSyncSite({ opIndex: 3, epoch: 0 }, BlockState.initial({
    registers: RegisterState.initial().write("eax", exprConst(0x11))
  }));
  const sites = valueSitesForRoots(valueSiteInput([site]));
  const plan = planBlockValues({
    sites,
    producedValues: [],
    sourceEffects: []
  });

  strictEqual(sites.length, 1);
  deepStrictEqual(plan.boundaries.map((boundary) => ({
    boundary: boundary.boundary,
    at: boundary.at,
    sites: boundary.sites.map((site) => site.cell)
  })), [
    {
      boundary: "stateSync",
      at: { opIndex: 3, epoch: 0 },
      sites: [{ kind: "reg", reg: "eax" }]
    }
  ]);
});

function valueSite(input: {
  key: number;
  opIndex: number;
  expr?: ExprRef;
  sourceCells?: readonly SourceCell[];
  definitionIds?: readonly BlockDefinitionId[];
}): ValueSite {
  const at = { opIndex: input.opIndex, epoch: 0 };
  const expr = input.expr ?? exprInput({ kind: "reg", reg: "eax" });
  const site = memoryStoreSite(at, expr);
  const root = Object.freeze({
    expr,
    at,
    purpose: Object.freeze({ kind: "actionInput", input: "value" }),
    site
  });

  return Object.freeze({
    kind: "actionInput",
    key: input.key,
    expr,
    root,
    at,
    deps: Object.freeze({
      sourceCells: Object.freeze([...(input.sourceCells ?? [])]),
      definitionIds: Object.freeze([...(input.definitionIds ?? [])])
    }),
    site,
    input: "value"
  });
}

function valueSiteInput(
  timeline: readonly BlockTimelineSite[]
): ValueSiteInput {
  const roots = rootsForBlockSites({ timeline });

  return {
    graph: buildExprGraph(roots.map((root) => root.expr)),
    roots
  };
}

function producedValue(id: BlockDefinitionId, index: number): ProducedValue {
  const at = { opIndex: index, epoch: 0 };
  const site = memoryLoadSite(at, id);

  return Object.freeze({
    id,
    at,
    site
  });
}

function sourceWrite(index: number, source: SourceCell): SourceEffect {
  const at = { opIndex: index, epoch: 0 };

  return Object.freeze({
    kind: "write",
    at,
    source,
    site: stateSyncSite(at, BlockState.initial())
  });
}

function registerBarrier(index: number): SourceEffect {
  const at = { opIndex: index, epoch: 0 };

  return Object.freeze({
    kind: "barrier",
    at,
    scope: "registers",
    site: dynamicRegisterStoreSite(at)
  });
}

function stateSyncSite(
  at: Placement,
  state: BlockState
): BlockBoundarySite {
  return Object.freeze({
    kind: "boundary",
    at,
    boundary: Object.freeze({
      kind: "stateSync",
      state
    })
  });
}

function memoryLoadSite(
  at: Placement,
  id: BlockDefinitionId
): BlockDefinitionSite &
  Readonly<{ definition: Extract<BlockDefinition, { kind: "memoryLoad" }> }> {
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
    } satisfies Extract<BlockDefinition, { kind: "memoryLoad" }>)
  });
}

function memoryStoreSite(
  at: Placement,
  value: ExprRef
): BlockActionSite &
  Readonly<{ action: Extract<BlockAction, { kind: "memoryStore" }> }> {
  return Object.freeze({
    kind: "action",
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

function dynamicRegisterStoreSite(
  at: Placement
): BlockActionSite &
  Readonly<{ action: Extract<BlockAction, { kind: "dynamicRegisterStore" }> }> {
  return Object.freeze({
    kind: "action",
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
