import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type { BlockAction } from "#ir/block/actions.js";
import {
  type BlockDefinition,
  type BlockDefinitionId
} from "#ir/block/definitions.js";
import {
  type BlockRoot,
  rootsForBlockSites
} from "#ir/block/roots.js";
import type {
  BlockDefinitionSite,
  BlockTimeline,
  Placement
} from "#ir/block/timeline.js";
import { opSite } from "#ir/block/walk/site.js";
import {
  BindingResolver,
  dynamicRegBinding
} from "#ir/block/bindings/resolver.js";
import { walkExpressionBlock } from "#ir/block/walk/index.js";
import { exprConst } from "#ir/expr/builders.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import {
  producedValuesForDefinitions,
  type ProducedValue
} from "#ir/block/values/plan/produced.js";
import {
  isActionInputValueRoot,
  isDefinitionInputValueRoot,
  valueRootsForRoots,
  type ValueRoot,
  type ValueRootInput
} from "#ir/block/values/plan/roots.js";

test("every non-passthrough root becomes one value root", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const roots = rootsForBlockSites({ timeline: result.timeline });
  const valueRoots = valueRootsForRoots(valueRootInput(result.timeline, roots));

  strictEqual(valueRoots.length, roots.length);
  deepStrictEqual(valueRoots.map(rootSummary), [
    {
      id: 0,
      kind: "actionInput",
      at: { opIndex: 0, epoch: 0 },
      action: "memoryGuard",
      input: "address"
    }
  ]);
});

test("duplicate roots remain duplicate value roots", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "mem", address: c(0x1000) }, value: c(0x55), accessWidth: 32 }
    ]
  });
  const root = rootsForBlockSites({ timeline: result.timeline }).find((candidate) =>
    candidate.purpose.kind === "actionInput" && candidate.purpose.input === "value"
  );

  if (root === undefined) {
    throw new Error("missing memory-store value root");
  }

  const valueRoots = valueRootsForRoots(valueRootInput(result.timeline, [root, root]));

  strictEqual(valueRoots.length, 2);
  strictEqual(valueRoots[0]?.id, 0);
  strictEqual(valueRoots[1]?.id, 1);
  strictEqual(valueRoots[0]?.root, root);
  strictEqual(valueRoots[1]?.root, root);
});

test("root purpose maps through the value-root helpers", () => {
  const memory = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x2000) }, accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x3000) }, value: v(0), accessWidth: 32 }
    ]
  });
  const dynamic = walkExpressionBlock({
    block: [
      { op: "get", dst: v(0), source: { kind: "operand", index: 0 }, accessWidth: 32 },
      { op: "set", target: { kind: "operand", index: 1 }, value: v(0), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [
        dynamicRegBinding(exprConst(1), 32),
        dynamicRegBinding(exprConst(2), 32)
      ]
    })
  });
  const branch = walkExpressionBlock({
    block: [
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const trap = walkExpressionBlock({
    block: [
      { op: "hostTrap", vector: c(7) }
    ]
  });
  const fallthrough = walkExpressionBlock({
    block: [
      { op: "next" }
    ],
    continuation: exprConst(0x90)
  });
  const timeline = [
    ...memory.timeline,
    ...dynamic.timeline,
    ...branch.timeline,
    ...trap.timeline,
    ...fallthrough.timeline
  ];
  const valueRoots = valueRootsForRoots(valueRootInput(timeline));

  requireActionRoot(valueRoots, "memoryGuard", "address");
  requireDefinitionRoot(valueRoots, "memoryLoad", "address");
  requireActionRoot(valueRoots, "memoryStore", "address");
  requireActionRoot(valueRoots, "memoryStore", "value");
  requireDefinitionRoot(valueRoots, "dynamicRegisterLoad", "index");
  requireActionRoot(valueRoots, "dynamicRegisterStore", "index");
  requireActionRoot(valueRoots, "dynamicRegisterStore", "value");
  requireActionRoot(valueRoots, "branch", "condition");
  requireActionRoot(valueRoots, "branch", "target", "taken");
  requireActionRoot(valueRoots, "branch", "target", "notTaken");
  requireActionRoot(valueRoots, "hostTrap", "vector");
  requireActionRoot(valueRoots, "fallthrough", "target");

  strictEqual(isActionInputValueRoot(valueRoots[0]!), true);
  strictEqual(isDefinitionInputValueRoot(requireDefinitionRoot(valueRoots, "memoryLoad", "address")), true);
});

test("definition sites become ProducedValues with access fields", () => {
  const timeline = [
    memoryLoadSite({ opIndex: 0, epoch: 0 }, 0 as BlockDefinitionId),
    dynamicRegisterLoadSite({ opIndex: 1, epoch: 0 }, 1 as BlockDefinitionId)
  ];
  const produced = producedValuesForDefinitions({ definitions: timeline });

  deepStrictEqual(produced.map(producedSummary), [
    {
      id: timeline[0]!.definition.id,
      at: { opIndex: 0, epoch: 0 },
      definition: "memoryLoad",
      access: {
        barrierDomain: "memory",
        input: exprConst(0x1000)
      }
    },
    {
      id: timeline[1]!.definition.id,
      at: { opIndex: 1, epoch: 0 },
      definition: "dynamicRegisterLoad",
      access: {
        barrierDomain: "registers",
        input: exprConst(1)
      }
    }
  ]);

});

function valueRootInput(
  timeline: BlockTimeline,
  roots = rootsForBlockSites({ timeline })
): ValueRootInput {
  return { roots };
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

function dynamicRegisterLoadSite(
  at: Placement,
  id: BlockDefinitionId
): BlockDefinitionSite &
  Readonly<{ definition: Extract<BlockDefinition, { kind: "dynamicRegisterLoad" }> }> {
  return Object.freeze({
    kind: "definition",
    at,
    definition: Object.freeze({
      kind: "dynamicRegisterLoad",
      id,
      at: opSite(at.opIndex),
      result: { kind: "def", id },
      index: exprConst(1),
      width: 32
    } satisfies Extract<BlockDefinition, { kind: "dynamicRegisterLoad" }>)
  });
}

function requireActionRoot(
  roots: readonly ValueRoot[],
  action: BlockAction["kind"],
  input: Extract<BlockRoot["purpose"], { kind: "actionInput" }>["input"],
  direction?: "taken" | "notTaken"
): ValueRoot {
  const root = roots.find((candidate) =>
    candidate.root.purpose.kind === "actionInput" &&
      candidate.root.site.kind === "action" &&
      candidate.root.site.action.kind === action &&
      candidate.root.purpose.input === input &&
      candidate.root.purpose.direction === direction
  );

  if (root === undefined) {
    throw new Error(`missing ${action} ${input} action value root`);
  }

  return root;
}

function requireDefinitionRoot(
  roots: readonly ValueRoot[],
  definition: BlockDefinition["kind"],
  input: Extract<BlockRoot["purpose"], { kind: "definitionInput" }>["input"]
): ValueRoot {
  const root = roots.find((candidate) =>
    candidate.root.purpose.kind === "definitionInput" &&
      candidate.root.site.kind === "definition" &&
      candidate.root.site.definition.kind === definition &&
      candidate.root.purpose.input === input
  );

  if (root === undefined) {
    throw new Error(`missing ${definition} ${input} definition value root`);
  }

  return root;
}

function rootSummary(root: ValueRoot): object {
  const blockRoot = root.root;
  const base = {
    id: root.id,
    kind: blockRoot.purpose.kind,
    at: blockRoot.at
  };

  switch (blockRoot.purpose.kind) {
    case "actionInput":
      if (blockRoot.site.kind !== "action") {
        throw new Error("action-input root must reference an action site");
      }

      return {
        ...base,
        action: blockRoot.site.action.kind,
        input: blockRoot.purpose.input,
        ...(blockRoot.purpose.direction === undefined ? {} : { direction: blockRoot.purpose.direction })
      };
    case "definitionInput":
      if (blockRoot.site.kind !== "definition") {
        throw new Error("definition-input root must reference a definition site");
      }

      return {
        ...base,
        definition: blockRoot.site.definition.kind,
        input: blockRoot.purpose.input
      };
  }
}

function producedSummary(value: ProducedValue): object {
  return {
    id: value.id,
    at: value.at,
    definition: value.site.definition.kind,
    access: value.access
  };
}

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
