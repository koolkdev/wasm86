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
import { exprsEqual } from "#ir/expr/equality.js";

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
