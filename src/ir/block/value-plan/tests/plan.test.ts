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
  type BlockRoot,
  rootsForBlockSites
} from "#ir/block/roots.js";
import type {
  BlockActionSite,
  BlockBoundarySite,
  BlockDefinitionSite,
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
  exprBinary,
  exprBits,
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
  valueRootsForRoots,
  type ValueRoot
} from "#ir/block/value-plan/value-roots.js";

test("repeated roots with the same graph key produce one planned value", () => {
  const expr = exprConst(7);
  const left = blockRoot({ expr, opIndex: 1 });
  const right = blockRoot({ expr, opIndex: 4 });
  const roots = valueRootsForRoots({ roots: [left, right] });
  const plan = planForRoots(roots);

  strictEqual(plan.values.length, 1);
  deepStrictEqual(plan.values[0]?.roots, roots);
  deepStrictEqual(plan.values[0]?.lifetime, {
    start: { opIndex: 1, epoch: 0 },
    end: { opIndex: 4, epoch: 0 }
  });
});

test("duplicate roots at the same placement are preserved", () => {
  const root = blockRoot({ expr: exprConst(3), opIndex: 2 });
  const roots = valueRootsForRoots({ roots: [root, root] });
  const plan = planForRoots(roots);

  strictEqual(plan.values[0]?.roots.length, 2);
  strictEqual(plan.values[0]?.roots[0], roots[0]);
  strictEqual(plan.values[0]?.roots[1], roots[1]);
  deepStrictEqual(plan.values[0]?.lifetime, {
    start: { opIndex: 2, epoch: 0 },
    end: { opIndex: 2, epoch: 0 }
  });
});

test("source effects do not split planned values by themselves", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const expr = exprInput({ kind: "reg", reg: "eax" });
  const roots = valueRootsForRoots({
    roots: [
      blockRoot({ expr, opIndex: 0 }),
      blockRoot({ expr, opIndex: 3 })
    ]
  });
  const plan = planForRoots(roots, {
    sourceEffects: [sourceWrite(1, source)]
  });

  strictEqual(plan.values.length, 1);
  strictEqual(plan.captures.length, 0);
});

test("source write before first root creates a capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const effect = sourceWrite(1, source);
  const roots = valueRootsForRoots({
    roots: [blockRoot({ expr: exprInput({ kind: "reg", reg: "eax" }), opIndex: 2 })]
  });
  const plan = planForRoots(roots, {
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

test("source captures use the first required placement before first root", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const firstWrite = sourceWrite(1, source);
  const laterWrite = sourceWrite(2, source);
  const afterFirstRoot = sourceWrite(4, source);
  const roots = valueRootsForRoots({
    roots: [blockRoot({ expr: exprInput({ kind: "reg", reg: "eax" }), opIndex: 3 })]
  });
  const plan = planForRoots(roots, {
    sourceEffects: [
      firstWrite,
      laterWrite,
      afterFirstRoot
    ]
  });

  strictEqual(plan.captures.length, 1);
  strictEqual(plan.captures[0]?.before, firstWrite);
  deepStrictEqual(plan.captures[0]?.at, { opIndex: 1, epoch: 0 });
});

test("source write at first root placement does not create a capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const roots = valueRootsForRoots({
    roots: [blockRoot({ expr: exprInput({ kind: "reg", reg: "eax" }), opIndex: 2 })]
  });
  const plan = planForRoots(roots, {
    sourceEffects: [sourceWrite(2, source)]
  });

  strictEqual(plan.captures.length, 0);
});

test("source write after first root does not create a capture", () => {
  const source = sourceCellForRegisterAlias(registerAlias("eax"));
  const roots = valueRootsForRoots({
    roots: [blockRoot({ expr: exprInput({ kind: "reg", reg: "eax" }), opIndex: 2 })]
  });
  const plan = planForRoots(roots, {
    sourceEffects: [sourceWrite(3, source)]
  });

  strictEqual(plan.captures.length, 0);
});

test("register barrier before first root captures register-backed values", () => {
  const regSource = sourceCellForRegisterAlias(registerAlias("eax"));
  const flagSource = sourceCellForFlag("ZF");
  const roots = valueRootsForRoots({
    roots: [
      blockRoot({ expr: exprInput({ kind: "reg", reg: "eax" }), opIndex: 2 }),
      blockRoot({ expr: exprInput({ kind: "flag", flag: "ZF" }), opIndex: 2 })
    ]
  });
  const plan = planForRoots(roots, {
    sourceEffects: [registerBarrier(1)]
  });

  deepStrictEqual(plan.captures.map((capture) => capture.source), [regSource]);
  strictEqual(flagSource.kind, "flag");
});

test("flag writes capture the same flag source once before first root", () => {
  const source = sourceCellForFlag("ZF");
  const firstWrite = sourceWrite(1, source);
  const roots = valueRootsForRoots({
    roots: [blockRoot({ expr: exprInput({ kind: "flag", flag: "ZF" }), opIndex: 3 })]
  });
  const plan = planForRoots(roots, {
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
  const roots = valueRootsForRoots({
    roots: [
      blockRoot({
        expr: exprBinary(
          "add",
          exprInput({ kind: "reg", reg: "eax" }),
          exprInput({ kind: "reg", reg: "ebx" })
        ),
        opIndex: 4
      })
    ]
  });
  const plan = planForRoots(roots, {
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
  const roots = valueRootsForRoots({
    roots: [
      blockRoot({
        expr: exprBits(exprInput({ kind: "reg", reg: "eax" }), 8, 8),
        opIndex: 2
      })
    ]
  });
  const plan = planForRoots(roots, {
    sourceEffects: [sourceWrite(1, sourceCellForRegisterAlias(registerAlias("al")))]
  });

  deepStrictEqual(plan.values[0]?.deps.sourceCells, [source]);
  strictEqual(plan.captures.length, 0);
});

test("mixed al and eax roots merge source cells to eax", () => {
  const expr = exprInput({ kind: "reg", reg: "eax" });
  const roots = valueRootsForRoots({
    roots: [
      blockRoot({ expr, opIndex: 1, width: 8 }),
      blockRoot({ expr, opIndex: 3, width: 32 })
    ]
  });
  const plan = planForRoots(roots);

  deepStrictEqual(plan.values[0]?.deps.sourceCells, [
    sourceCellForRegisterAlias(registerAlias("eax"))
  ]);
});

test("produced value consumers are found through definitionIds", () => {
  const id = 4 as BlockDefinitionId;
  const unusedId = 5 as BlockDefinitionId;
  const produced = producedValue(id, 1);
  const unusedProduced = producedValue(unusedId, 2);
  const consumer = valueRootsForRoots({
    roots: [blockRoot({ expr: exprInput({ kind: "def", id }), opIndex: 5 })]
  })[0]!;
  const plan = planForRoots([consumer], {
    producedValues: [produced, unusedProduced]
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
  const roots = valueRootsForRoots({
    roots: [blockRoot({ expr: exprInput({ kind: "def", id }), opIndex: 3 })]
  });
  const plan = planForRoots(roots, {
    producedValues: [produced],
    sourceEffects: [sourceWrite(1, sourceCellForRegisterAlias(registerAlias("eax")))]
  });

  strictEqual(plan.captures.length, 0);
  strictEqual(Object.hasOwn(plan.produced[0]!, "captures"), false);
});

test("boundary views contain only non-passthrough boundary roots", () => {
  const site = stateSyncSite({ opIndex: 3, epoch: 0 }, BlockState.initial({
    registers: RegisterState.initial().write("eax", exprConst(0x11))
  }));
  const roots = valueRootsForRoots({ roots: rootsForBlockSites({ timeline: [site] }) });
  const plan = planForRoots(roots);

  strictEqual(roots.length, 1);
  deepStrictEqual(plan.boundaries.map((boundary) => ({
    boundary: boundary.boundary,
    at: boundary.at,
    roots: boundary.roots.map((root) =>
      root.root.purpose.kind === "boundaryCell" ? root.root.purpose.cell : undefined
    )
  })), [
    {
      boundary: "stateSync",
      at: { opIndex: 3, epoch: 0 },
      roots: [{ kind: "reg", reg: "eax" }]
    }
  ]);
});

function planForRoots(
  valueRoots: readonly ValueRoot[],
  input: Partial<{
    producedValues: readonly ProducedValue[];
    sourceEffects: readonly SourceEffect[];
  }> = {}
) {
  return planBlockValues({
    graph: buildExprGraph(valueRoots.map((root) => root.root.expr)),
    valueRoots,
    producedValues: input.producedValues ?? [],
    sourceEffects: input.sourceEffects ?? []
  });
}

function blockRoot(input: {
  opIndex: number;
  expr: ExprRef;
  width?: 8 | 16 | 32;
}): BlockRoot {
  const at = { opIndex: input.opIndex, epoch: 0 };
  const site = memoryStoreSite(at, input.expr, input.width ?? 32);

  return Object.freeze({
    expr: input.expr,
    at,
    purpose: Object.freeze({ kind: "actionInput", input: "value" }),
    site
  });
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
  value: ExprRef,
  width: 8 | 16 | 32
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
      width
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
