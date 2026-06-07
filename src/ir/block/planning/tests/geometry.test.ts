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
import { modRmSelector } from "#ir/block/modrm-selector.js";
import {
  buildTimelineGeometry,
  comparePathOrder,
  compareProgramPoints,
  pathCovers,
  pathsInTree,
  programPointsEqual,
  type EdgePath,
  type ProgramPoint,
  type Path
} from "#ir/block/planning/geometry/index.js";
import { walkExpressionBlock } from "#ir/block/walk/index.js";
import { exprConst } from "#ir/expr/builders.js";
import type {
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";

test("timeline geometry creates before/at/after points for every timeline site", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" },
      { op: "get", dst: v(0), source: { kind: "mem", address: c(0x1000) }, accessWidth: 32 },
      { op: "set", target: { kind: "mem", address: c(0x2000) }, value: v(0), accessWidth: 32 },
      { op: "next" }
    ],
    continuation: exprConst(0x3000)
  });
  const geometry = buildTimelineGeometry(result);

  strictEqual(geometry.points.bySite.size, result.timeline.length);
  strictEqual(geometry.definitions.points.length, 1);
  strictEqual(
    geometry.definitions.byDefinition.get(geometry.definitions.points[0]!.definition.id),
    geometry.definitions.points[0]
  );
  strictEqual(geometry.memory.writes.length, 1);
  strictEqual(geometry.memory.writes[0]?.site.action.kind, "memoryStore");

  for (const site of result.timeline) {
    const points = geometry.points.bySite.get(site);

    strictEqual(points?.before.phase, "before");
    strictEqual(points?.at.phase, "at");
    strictEqual(points?.after.phase, "after");
    strictEqual(points?.before.path.kind, "main");
    deepStrictEqual(points?.before.at, site.at);
    deepStrictEqual(points?.at.at, site.at);
    deepStrictEqual(points?.after.at, site.at);
    strictEqual(compareProgramPoints(points!.before, points!.at) < 0, true);
    strictEqual(compareProgramPoints(points!.at, points!.after) < 0, true);
  }
});

test("timeline geometry creates a memory-fault exit path from memory guards", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });
  const geometry = buildTimelineGeometry(result);
  const guardPoint = geometry.memory.guards[0]!;
  const exitPoint = geometry.exits.points[0]!;
  const edge = geometry.edges.byExit.get(exitPoint.exit.id)!;

  strictEqual(geometry.memory.guards.length, 1);
  strictEqual(geometry.edges.all.length, 1);
  strictEqual(geometry.exits.points.length, 1);
  strictEqual(exitPoint.exit.kind, "memoryFault");
  strictEqual(edge.kind, "memory-fault");
  strictEqual(edge.exit, exitPoint.exit);
  strictEqual(edge.sourceSite, guardPoint.site);
  strictEqual(geometry.edges.byId.get(edge.id), edge);
  strictEqual(geometry.edges.byPath.get(exitPoint.path), edge);
  strictEqual(geometry.exits.byExit.get(exitPoint.exit.id), exitPoint);
  strictEqual(exitPoint.path.kind, "edge");
  strictEqual(exitPoint.path.edge, edge.id);
  strictEqual(exitPoint.edge, edge.id);
  strictEqual(guardPoint.faultExitPoint, exitPoint);
  strictEqual(pathCovers(geometry.paths, geometry.paths.root, exitPoint.path), true);
});

test("timeline geometry creates taken and not-taken paths for branches", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const geometry = buildTimelineGeometry(result);
  const branchPaths = pathsInTree(geometry.paths).filter((path): path is EdgePath =>
    path.kind === "edge" && geometry.edges.byPath.get(path)?.kind.startsWith("branch-") === true
  );

  deepStrictEqual(branchPaths.map((path) => geometry.edges.byPath.get(path)?.kind), [
    "branch-taken",
    "branch-not-taken"
  ]);
  strictEqual(geometry.exits.points.length, 2);
  deepStrictEqual(geometry.exits.points.map((point) => point.path.kind), ["edge", "edge"]);
  deepStrictEqual(geometry.exits.points.map((point) =>
    geometry.edges.byExit.get(point.exit.id)?.kind
  ), ["branch-taken", "branch-not-taken"]);
  strictEqual(pathCovers(geometry.paths, geometry.paths.root, branchPaths[0]!), true);
  strictEqual(pathCovers(geometry.paths, branchPaths[0]!, branchPaths[1]!), false);
});

test("path coverage uses path tree object ownership", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "conditionalJump", condition: c(1), taken: c(0x40), notTaken: c(0x44) }
    ]
  });
  const geometry = buildTimelineGeometry(result);
  const ownedTaken = pathsInTree(geometry.paths).find((path): path is EdgePath =>
    path.kind === "edge" && geometry.edges.byPath.get(path)?.kind === "branch-taken"
  )!;
  strictEqual(ownedTaken.kind, "edge");
  const clonedMain = Object.freeze({ kind: "main" } satisfies Path);
  const clonedTaken = Object.freeze({
    kind: "edge",
    edge: ownedTaken.edge
  } satisfies Path);
  const ownedMainPoint = geometry.points.bySite.get(result.timeline[0]!)!.at;
  const clonedMainPoint = Object.freeze({
    path: clonedMain,
    at: ownedMainPoint.at,
    phase: ownedMainPoint.phase
  } satisfies ProgramPoint);

  strictEqual(pathCovers(geometry.paths, geometry.paths.root, ownedTaken), true);
  strictEqual(pathCovers(geometry.paths, clonedMain, ownedTaken), false);
  strictEqual(pathCovers(geometry.paths, geometry.paths.root, clonedTaken), false);
  strictEqual(comparePathOrder(geometry.paths.root, clonedMain), 0);
  strictEqual(comparePathOrder(ownedTaken, clonedTaken), 0);
  strictEqual(geometry.paths.root === clonedMain, false);
  strictEqual(programPointsEqual(ownedMainPoint, ownedMainPoint), true);
  strictEqual(programPointsEqual(ownedMainPoint, clonedMainPoint), false);
});

test("timeline geometry creates exit paths for jump, host trap, and fallthrough exits", () => {
  const jump = buildTimelineGeometry(walkExpressionBlock({
    block: [
      { op: "jump", target: c(0x80) }
    ]
  }));
  const hostTrap = buildTimelineGeometry(walkExpressionBlock({
    block: [
      { op: "hostTrap", vector: c(0x13) }
    ]
  }));
  const fallthrough = buildTimelineGeometry(walkExpressionBlock({
    block: [
      { op: "next" }
    ],
    continuation: exprConst(0x90)
  }));

  deepStrictEqual(
    [jump, hostTrap, fallthrough].map((geometry) => geometry.exits.points[0]?.path.kind),
    ["edge", "edge", "edge"]
  );
  deepStrictEqual(
    [jump, hostTrap, fallthrough].map((geometry) =>
      geometry.edges.byExit.get(geometry.exits.points[0]!.exit.id)?.kind
    ),
    ["jump", "host-trap", "fallthrough"]
  );
});

test("timeline geometry exposes dynamic register store action and pre-state points", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "set", target: { kind: "operand", index: 0 }, value: c(0x55), accessWidth: 32 }
    ],
    resolver: new BindingResolver({
      operands: [dynamicRegBinding(modRmSelector(exprConst(2)), 32)]
    })
  });
  const geometry = buildTimelineGeometry(result);
  const storePoint = geometry.registers.dynamicStores[0]!;

  strictEqual(geometry.registers.dynamicStores.length, 1);
  strictEqual(storePoint.site.action.kind, "dynamicRegisterStore");
  strictEqual(storePoint.preStatePoint.phase, "before");
  strictEqual(storePoint.point.phase, "at");
  strictEqual(compareProgramPoints(storePoint.preStatePoint, storePoint.point) < 0, true);
});

test("timeline geometry rejects timeline exits missing from the walked exit list", () => {
  const result = walkExpressionBlock({
    block: [
      { op: "memory.guard", address: c(0x1000), byteLength: 4, access: "read" }
    ]
  });

  throws(
    () => buildTimelineGeometry({
      timeline: result.timeline,
      exits: []
    }),
    /timeline action references unknown block exit/
  );
});

function v(id: number): VarRef {
  return { kind: "var", id };
}

function c(value: number): ValueRef {
  return { kind: "const", type: "i32" satisfies IrValueType, value };
}
