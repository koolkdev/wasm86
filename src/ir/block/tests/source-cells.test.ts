import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  BlockRoot,
  BlockRootPurpose
} from "#ir/block/roots.js";
import type { BlockScheduleEntry } from "#ir/block/schedule.js";
import {
  sourceCellsForExpr,
  sourceCellsForRoot
} from "#ir/block/source-cells.js";
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

test("source-cell analysis exposes register aliases for projections and bit slices", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(sourceCellsForExpr(exprProject(8, eax)).sources, [
    { kind: "reg", reg: registerAlias("al") }
  ]);
  deepStrictEqual(sourceCellsForExpr(exprBits(eax, 8, 8)).sources, [
    { kind: "reg", reg: registerAlias("ah") }
  ]);
  deepStrictEqual(sourceCellsForExpr(exprProject(16, eax)).sources, [
    { kind: "reg", reg: registerAlias("ax") }
  ]);
});

test("source-cell analysis widens non-alias-shaped register dependencies", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const lowAndHighByte = exprBinary("or", exprProject(8, eax), exprBits(eax, 8, 8));
  const lowAndThirdByte = exprBinary("or", exprProject(8, eax), exprBits(eax, 16, 8));
  const espLowByte = exprProject(8, exprInput({ kind: "reg", reg: "esp" }));

  deepStrictEqual(sourceCellsForExpr(lowAndHighByte).sources, [
    { kind: "reg", reg: registerAlias("ax") }
  ]);
  deepStrictEqual(sourceCellsForExpr(lowAndThirdByte).sources, [
    { kind: "reg", reg: registerAlias("eax") }
  ]);
  deepStrictEqual(sourceCellsForExpr(espLowByte).sources, [
    { kind: "reg", reg: registerAlias("sp") }
  ]);
});

test("source-cell analysis covers compares, insertions, and sign extension", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });

  deepStrictEqual(sourceCellsForExpr(exprUnary("extend8_s", eax)).sources, [
    { kind: "reg", reg: registerAlias("al") }
  ]);
  deepStrictEqual(sourceCellsForExpr(exprCompare(16, "lt_u", eax, ebx)).sources, [
    { kind: "reg", reg: registerAlias("ax") },
    { kind: "reg", reg: registerAlias("bx") }
  ]);
  deepStrictEqual(
    sourceCellsForExpr(exprInsertBits(eax, exprProject(8, ebx), 8, 8)).sources,
    [
      { kind: "reg", reg: registerAlias("eax") },
      { kind: "reg", reg: registerAlias("bl") }
    ]
  );
  deepStrictEqual(
    sourceCellsForExpr(exprBinary("add", exprProject(8, eax), exprConst(1))).sources,
    [
      { kind: "reg", reg: registerAlias("al") }
    ]
  );
});

test("root source-cell analysis uses schedule entries for store widths", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(sourceCellsForRoot(actionValueRoot("memoryStore", eax, 8)).sources, [
    { kind: "reg", reg: registerAlias("al") }
  ]);
  deepStrictEqual(
    sourceCellsForRoot(actionValueRoot("dynamicRegisterStore", eax, 16)).sources,
    [
      { kind: "reg", reg: registerAlias("ax") }
    ]
  );
  deepStrictEqual(sourceCellsForExpr(eax).sources, [
    { kind: "reg", reg: registerAlias("eax") }
  ]);
  deepStrictEqual(
    sourceCellsForRoot(
      actionValueRoot("memoryStore", exprBinary("add", eax, exprConst(1)), 8)
    ).sources,
    [
      { kind: "reg", reg: registerAlias("eax") }
    ]
  );
});

test("source-cell analysis reports definition ids without requested consumer shape", () => {
  const id = 7 as BlockDefinitionId;
  const loaded = exprInput({ kind: "def", id });
  const combined = exprBinary("or", exprProject(8, loaded), exprBits(loaded, 8, 8));

  deepStrictEqual(sourceCellsForExpr(combined).definitions, [id]);
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
  const entry: BlockScheduleEntry = kind === "memoryStore"
    ? Object.freeze({
        role: "action",
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
        role: "action",
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
    entry
  });
}
