import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import type { BlockDefinitionId } from "#ir/block/definitions.js";
import {
  exprDepsForExpr,
  exprDepsForRoot
} from "#ir/block/expr-deps.js";
import type {
  BlockRoot,
  BlockRootPurpose
} from "#ir/block/roots.js";
import type { BlockTimelineSite } from "#ir/block/timeline.js";
import { opSite } from "#ir/block/walk/index.js";
import {
  exprBinary,
  exprBits,
  exprCompare,
  exprConst,
  exprInput,
  exprInsertBits,
  exprProject,
  exprUnary
} from "#ir/expr/builders.js";
import type { ExprRef } from "#ir/expr/types.js";
import { registerAlias } from "#x86/registers.js";

test("exprDepsForExpr(input eax) reports eax", () => {
  deepStrictEqual(exprDepsForExpr(exprInput({ kind: "reg", reg: "eax" })), {
    sourceCells: [
      { kind: "reg", reg: registerAlias("eax") }
    ],
    definitionIds: []
  });
});

test("expression dependencies expose register aliases for projections and bit slices", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(exprDepsForExpr(exprProject(8, eax)).sourceCells, [
    { kind: "reg", reg: registerAlias("al") }
  ]);
  deepStrictEqual(exprDepsForExpr(exprBits(eax, 8, 8)).sourceCells, [
    { kind: "reg", reg: registerAlias("ah") }
  ]);
  deepStrictEqual(exprDepsForExpr(exprProject(16, eax)).sourceCells, [
    { kind: "reg", reg: registerAlias("ax") }
  ]);
});

test("expression dependencies widen non-alias-shaped register dependencies", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const lowAndHighByte = exprBinary("or", exprProject(8, eax), exprBits(eax, 8, 8));
  const lowAndThirdByte = exprBinary("or", exprProject(8, eax), exprBits(eax, 16, 8));
  const espLowByte = exprProject(8, exprInput({ kind: "reg", reg: "esp" }));

  deepStrictEqual(exprDepsForExpr(lowAndHighByte).sourceCells, [
    { kind: "reg", reg: registerAlias("ax") }
  ]);
  deepStrictEqual(exprDepsForExpr(lowAndThirdByte).sourceCells, [
    { kind: "reg", reg: registerAlias("eax") }
  ]);
  deepStrictEqual(exprDepsForExpr(espLowByte).sourceCells, [
    { kind: "reg", reg: registerAlias("sp") }
  ]);
});

test("expression dependencies cover compares, insertions, and sign extension", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });

  deepStrictEqual(exprDepsForExpr(exprUnary("extend8_s", eax)).sourceCells, [
    { kind: "reg", reg: registerAlias("al") }
  ]);
  deepStrictEqual(exprDepsForExpr(exprCompare(16, "lt_u", eax, ebx)).sourceCells, [
    { kind: "reg", reg: registerAlias("ax") },
    { kind: "reg", reg: registerAlias("bx") }
  ]);
  deepStrictEqual(
    exprDepsForExpr(exprInsertBits(eax, exprProject(8, ebx), 8, 8)).sourceCells,
    [
      { kind: "reg", reg: registerAlias("eax") },
      { kind: "reg", reg: registerAlias("bl") }
    ]
  );
  deepStrictEqual(
    exprDepsForExpr(exprBinary("add", exprProject(8, eax), exprConst(1))).sourceCells,
    [
      { kind: "reg", reg: registerAlias("al") }
    ]
  );
});

test("exprDepsForRoot(byte memory-store value=input eax) reports al", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(exprDepsForRoot(actionValueRoot("memoryStore", eax, 8)).sourceCells, [
    { kind: "reg", reg: registerAlias("al") }
  ]);
  deepStrictEqual(
    exprDepsForRoot(actionValueRoot("dynamicRegisterStore", eax, 16)).sourceCells,
    [
      { kind: "reg", reg: registerAlias("ax") }
    ]
  );
  deepStrictEqual(exprDepsForExpr(eax).sourceCells, [
    { kind: "reg", reg: registerAlias("eax") }
  ]);
  deepStrictEqual(
    exprDepsForRoot(
      actionValueRoot("memoryStore", exprBinary("add", eax, exprConst(1)), 8)
    ).sourceCells,
    [
      { kind: "reg", reg: registerAlias("eax") }
    ]
  );
});

test("exprDepsForExpr(input def(3)) reports definition id 3", () => {
  const id = 3 as BlockDefinitionId;

  deepStrictEqual(exprDepsForExpr(exprInput({ kind: "def", id })), {
    sourceCells: [],
    definitionIds: [id]
  });
});

test("definition ids stay dependency ids without requested consumer shape", () => {
  const id = 7 as BlockDefinitionId;
  const loaded = exprInput({ kind: "def", id });
  const combined = exprBinary("or", exprProject(8, loaded), exprBits(loaded, 8, 8));

  deepStrictEqual(exprDepsForExpr(combined).definitionIds, [id]);
});

test("ExprUse is not exported as an expression type or helper module", () => {
  const typesSource = readFileSync(new URL("../../expr/types.js", import.meta.url), "utf8");

  strictEqual(typesSource.includes("ExprUse"), false);
  strictEqual(existsSync(new URL("../../expr/uses.js", import.meta.url)), false);
});

function actionValueRoot(
  kind: "memoryStore" | "dynamicRegisterStore",
  expr: ExprRef,
  width: 8 | 16 | 32
): BlockRoot {
  const actionAt = opSite(0);
  const at = Object.freeze({ opIndex: 0, epoch: 0 });
  const purpose: BlockRootPurpose = Object.freeze({ kind: "actionInput", input: "value" });
  const site: BlockTimelineSite = kind === "memoryStore"
    ? Object.freeze({
        kind: "action",
        at,
        action: Object.freeze({
          kind,
          at: actionAt,
          address: exprConst(0),
          value: expr,
          width
        })
      })
    : Object.freeze({
        kind: "action",
        at,
        action: Object.freeze({
          kind,
          at: actionAt,
          index: exprConst(0),
          value: expr,
          width
        })
      });

  return Object.freeze({
    expr,
    at,
    purpose,
    site
  });
}
