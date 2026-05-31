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
  BlockDefinitionSite,
  Placement
} from "#ir/block/timeline.js";
import {
  sourceCellForRegisterAlias
} from "#ir/block/source-cells.js";
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
} from "#ir/block/values/plan/plan.js";
import {
  producedValueForDefinitionSite,
  producedValuesForDefinitions,
  type ProducedValue
} from "#ir/block/values/plan/produced.js";
import {
  valueRootsForRoots,
  type ValueRoot
} from "#ir/block/values/plan/roots.js";

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
    inputs: planned.inputs,
    consumers: planned.consumers,
    lifetime: planned.lifetime
  })), [
    {
      produced,
      inputs: [],
      consumers: [consumer],
      lifetime: {
        start: { opIndex: 1, epoch: 0 },
        end: { opIndex: 5, epoch: 0 }
      }
    }
  ]);
});

test("produced value input roots are retained for consumed produced values", () => {
  const id = 8 as BlockDefinitionId;
  const site = memoryLoadSite({ opIndex: 1, epoch: 0 }, id);
  const produced = producedValuesForDefinitions({ definitions: [site] })[0]!;
  const input = valueRootsForRoots({ roots: rootsForBlockSites({ timeline: [site] }) })[0]!;
  const consumer = valueRootsForRoots({
    roots: [blockRoot({ expr: exprInput({ kind: "def", id }), opIndex: 4 })]
  })[0]!;
  const plan = planForRoots([input, consumer], {
    producedValues: [produced]
  });

  strictEqual(plan.produced.length, 1);
  deepStrictEqual(plan.produced[0]?.inputs, [input]);
  deepStrictEqual(plan.produced[0]?.consumers, [consumer]);
});

test("produced values without consumers are omitted", () => {
  const id = 9 as BlockDefinitionId;
  const site = memoryLoadSite({ opIndex: 1, epoch: 0 }, id);
  const produced = producedValuesForDefinitions({ definitions: [site] })[0]!;
  const input = valueRootsForRoots({ roots: rootsForBlockSites({ timeline: [site] }) })[0]!;
  const plan = planForRoots([input], {
    producedValues: [produced]
  });

  deepStrictEqual(plan.produced, []);
});

function planForRoots(
  valueRoots: readonly ValueRoot[],
  input: Partial<{
    producedValues: readonly ProducedValue[];
  }> = {}
) {
  return planBlockValues({
    graph: buildExprGraph(valueRoots.map((root) => root.root.expr)),
    valueRoots,
    producedValues: input.producedValues ?? []
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

  return producedValueForDefinitionSite(site);
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
