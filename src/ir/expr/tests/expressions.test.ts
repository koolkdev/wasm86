import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  exprBinary,
  exprCompare,
  exprConst,
  exprInput,
  exprInsertBits,
  exprProject,
  exprSelect,
  exprUnary,
  exprBits
} from "#ir/expr/builders.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import {
  exprChildren,
  exprChildSlots,
  type ExprChildSlot
} from "#ir/expr/children.js";
import { exprsEqual } from "#ir/expr/equality.js";
import type { ExprRef } from "#ir/expr/types.js";

test("ExprRef child slots name semantic roles in child order", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const zf = exprInput({ kind: "flag", flag: "ZF" });
  const leaf = exprConst(7);
  const cases: readonly Readonly<{ expr: ExprRef; slots: readonly ExprChildSlot[] }>[] = [
    { expr: leaf, slots: [] },
    { expr: eax, slots: [] },
    { expr: exprBinary("xor", eax, ebx), slots: [{ role: "left", expr: eax }, { role: "right", expr: ebx }] },
    { expr: exprUnary("popcnt", eax), slots: [{ role: "value", expr: eax }] },
    {
      expr: exprSelect(zf, eax, ebx),
      slots: [
        { role: "condition", expr: zf },
        { role: "whenTrue", expr: eax },
        { role: "whenFalse", expr: ebx }
      ]
    },
    { expr: exprProject(8, eax), slots: [{ role: "value", expr: eax }] },
    { expr: exprBits(eax, 8, 8), slots: [{ role: "value", expr: eax }] },
    { expr: exprInsertBits(eax, ebx, 8, 8), slots: [{ role: "base", expr: eax }, { role: "value", expr: ebx }] },
    { expr: exprCompare(16, "eq", eax, ebx), slots: [{ role: "left", expr: eax }, { role: "right", expr: ebx }] }
  ];

  for (const valueCase of cases) {
    deepStrictEqual(exprChildSlots(valueCase.expr), valueCase.slots);
    deepStrictEqual(exprChildren(valueCase.expr), valueCase.slots.map((slot) => slot.expr));
  }
});

test("ExprRef semantic projection constants canonicalize without consumer metadata", () => {
  deepStrictEqual(
    canonicalizeExpr(exprProject(8, exprConst(0x1234_5678))),
    exprConst(0x78)
  );
});

test("ExprRef nested projections collapse only to identical semantics", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const nested = exprProject(16, exprProject(8, eax));
  const expected = exprProject(8, eax);

  deepStrictEqual(canonicalizeExpr(nested), expected);
  strictEqual(exprsEqual(canonicalizeExpr(nested), expected), true);
});

test("ExprRef aliases derive from canonical register inputs", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(canonicalizeExpr(exprBits(eax, 0, 8)), exprProject(8, eax));
});

test("ExprRef canonicalization keeps arithmetic and condition shapes", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const addZero = exprBinary("add", eax, exprConst(0));
  const selfCompare = exprCompare(32, "eq", eax, eax);
  const constSelect = exprSelect(exprConst(1), eax, ebx);

  deepStrictEqual(canonicalizeExpr(addZero), addZero);
  deepStrictEqual(canonicalizeExpr(selfCompare), selfCompare);
  deepStrictEqual(canonicalizeExpr(constSelect), constSelect);
});

test("ExprRef equality keeps semantic projections separate from input identity", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const projected = exprProject(8, eax);

  strictEqual(exprsEqual(canonicalizeExpr(projected), canonicalizeExpr(eax)), false);
  strictEqual(exprsEqual(canonicalizeExpr(exprProject(8, exprConst(0x1234_5678))), exprConst(0x78)), true);
  strictEqual(exprsEqual(canonicalizeExpr(exprBinary("add", eax, exprConst(0))), eax), false);
});

test("ExprRef canonicalization removes no-op alias insertions", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(canonicalizeExpr(exprInsertBits(eax, exprProject(8, eax), 0, 8)), eax);
  deepStrictEqual(canonicalizeExpr(exprInsertBits(eax, exprBits(eax, 8, 8), 8, 8)), eax);
});

test("ExprRef popcnt remains an explicit scalar expression", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(canonicalizeExpr(exprUnary("popcnt", exprBinary("and", eax, exprConst(0xff)))), exprUnary(
    "popcnt",
    exprBinary("and", eax, exprConst(0xff))
  ));
});
