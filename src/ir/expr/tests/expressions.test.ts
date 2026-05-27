import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  exprBits,
  exprBinary,
  exprCompare,
  exprConst,
  exprInput,
  exprInsertBits,
  exprProject,
  exprSelect,
  exprUnary
} from "#ir/expr/builders.js";
import { exprDependencies } from "#ir/expr/dependencies.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import { exprsEqual } from "#ir/expr/equality.js";
import {
  bitsUse,
  childUseForExpr,
  exactUse,
  exprUseSatisfies,
  full32Use
} from "#ir/expr/uses.js";

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

test("ExprRef high-mask demand through low projection observes no input bits", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const projected = exprProject(8, eax);

  deepStrictEqual(childUseForExpr(projected, 0, bitsUse(0xff00)), bitsUse(0));
  deepStrictEqual(exprDependencies(projected, bitsUse(0xff00)), []);
});

test("ExprRef demand dependencies match projection emission uses", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const projected = exprProject(8, eax);

  deepStrictEqual(exprDependencies(projected, bitsUse(0xff)), [
    { kind: "reg", reg: "eax", mask: 0x00ff }
  ]);
  deepStrictEqual(exprDependencies(projected, bitsUse(0xff00)), []);
  deepStrictEqual(exprDependencies(projected, full32Use()), [
    { kind: "reg", reg: "eax", mask: 0x00ff }
  ]);
});

test("ExprRef byte store and use contracts keep dependency demand precise", () => {
  const highByte = exprBits(exprInput({ kind: "reg", reg: "eax" }), 8, 8);

  deepStrictEqual(exprDependencies(exprProject(8, exprInput({ kind: "reg", reg: "eax" })), bitsUse(0xff)), [
    { kind: "reg", reg: "eax", mask: 0x00ff }
  ]);
  deepStrictEqual(exprDependencies(highByte, full32Use()), [
    { kind: "reg", reg: "eax", mask: 0xff00 }
  ]);
  strictEqual(exprUseSatisfies(bitsUse(0xff), exactUse()), false);
});

test("ExprRef high-bit demand through compare results observes no input bits", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });

  deepStrictEqual(exprDependencies(exprCompare(32, "eq", eax, ebx), bitsUse(0xff00)), []);
  deepStrictEqual(exprDependencies(exprCompare(8, "lt_s", eax, ebx), bitsUse(0xff00)), []);
});

test("ExprRef popcnt dependencies are explicit and can be narrowed by real bitwise ops", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const lowByte = exprBinary("and", eax, exprConst(0xff));

  deepStrictEqual(exprDependencies(exprUnary("popcnt", eax), bitsUse(1)), [
    { kind: "reg", reg: "eax", mask: 0xffff_ffff }
  ]);
  deepStrictEqual(exprDependencies(exprUnary("popcnt", lowByte), bitsUse(1)), [
    { kind: "reg", reg: "eax", mask: 0xff }
  ]);
  deepStrictEqual(canonicalizeExpr(exprUnary("popcnt", exprConst(0b1011))), exprUnary("popcnt", exprConst(0b1011)));
});

test("ExprRef compare dependencies use the explicit operation width", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const cases = [
    { width: 8, op: "lt_s", mask: 0x0000_00ff },
    { width: 16, op: "lt_s", mask: 0x0000_ffff },
    { width: 32, op: "lt_s", mask: 0xffff_ffff },
    { width: 8, op: "lt_u", mask: 0x0000_00ff },
    { width: 16, op: "lt_u", mask: 0x0000_ffff },
    { width: 32, op: "lt_u", mask: 0xffff_ffff },
    { width: 8, op: "eq", mask: 0x0000_00ff },
    { width: 16, op: "ne", mask: 0x0000_ffff },
    { width: 32, op: "eq", mask: 0xffff_ffff }
  ] as const;

  for (const valueCase of cases) {
    deepStrictEqual(exprDependencies(exprCompare(valueCase.width, valueCase.op, eax, ebx)), [
      { kind: "reg", reg: "eax", mask: valueCase.mask },
      { kind: "reg", reg: "ebx", mask: valueCase.mask }
    ]);
  }
});

test("ExprRef aliases derive from canonical register inputs", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(canonicalizeExpr(exprBits(eax, 0, 8)), exprProject(8, eax));
  deepStrictEqual(exprDependencies(exprProject(8, eax)), [
    { kind: "reg", reg: "eax", mask: 0x00ff }
  ]);
  deepStrictEqual(exprDependencies(exprBits(eax, 8, 8)), [
    { kind: "reg", reg: "eax", mask: 0xff00 }
  ]);
  deepStrictEqual(exprDependencies(exprProject(16, eax)), [
    { kind: "reg", reg: "eax", mask: 0xffff }
  ]);
});

test("ExprRef flag inputs are per-flag cells", () => {
  const zf = exprInput({ kind: "flag", flag: "ZF" });

  deepStrictEqual(exprDependencies(zf), [
    { kind: "flag", flag: "ZF" }
  ]);
  deepStrictEqual(exprDependencies(zf, bitsUse(0)), []);
});

test("ExprRef def inputs are dependencies for block-defined values", () => {
  const loaded = exprInput({ kind: "def", id: 0 });
  const combined = exprBinary("add", loaded, exprConst(1));

  deepStrictEqual(exprDependencies(combined), [
    { kind: "def", id: 0 }
  ]);
  deepStrictEqual(exprDependencies(combined, bitsUse(0)), []);
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

test("ExprRef equality keeps semantic projections separate from partial uses", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const projected = exprProject(8, eax);

  strictEqual(exprsEqual(canonicalizeExpr(projected), canonicalizeExpr(eax)), false);
  strictEqual(exprsEqual(canonicalizeExpr(exprProject(8, exprConst(0x1234_5678))), exprConst(0x78)), true);
  strictEqual(exprsEqual(canonicalizeExpr(exprBinary("add", eax, exprConst(0))), eax), false);
});

test("ExprRef partial bit use cannot satisfy full semantic reuse", () => {
  strictEqual(exprUseSatisfies(bitsUse(0xff), full32Use()), false);
  strictEqual(exprUseSatisfies(bitsUse(0xff), exactUse()), false);
  strictEqual(exprUseSatisfies(full32Use(), bitsUse(0xff)), true);
});

test("ExprRef insertion demand splits between preserved and inserted bits", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebxLow = exprBits(exprInput({ kind: "reg", reg: "ebx" }), 0, 8);
  const inserted = exprInsertBits(eax, ebxLow, 8, 8);

  deepStrictEqual(exprDependencies(inserted, bitsUse(0x00ff)), [
    { kind: "reg", reg: "eax", mask: 0x00ff }
  ]);
  deepStrictEqual(exprDependencies(inserted, bitsUse(0xff00)), [
    { kind: "reg", reg: "ebx", mask: 0x00ff }
  ]);
});

test("ExprRef dependencies merge repeated register inputs structurally", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const combined = exprBinary("or", exprProject(8, eax), exprBits(eax, 8, 8));

  deepStrictEqual(exprDependencies(combined), [
    { kind: "reg", reg: "eax", mask: 0xffff }
  ]);
});

test("ExprRef canonicalization removes no-op alias insertions", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(canonicalizeExpr(exprInsertBits(eax, exprProject(8, eax), 0, 8)), eax);
  deepStrictEqual(canonicalizeExpr(exprInsertBits(eax, exprBits(eax, 8, 8), 8, 8)), eax);
});
