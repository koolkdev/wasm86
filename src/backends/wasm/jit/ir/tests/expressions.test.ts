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
  exprSelect
} from "#backends/wasm/jit/ir/expressions/builders.js";
import { exprDependencies } from "#backends/wasm/jit/ir/expressions/dependencies.js";
import { canonicalizeExpr } from "#backends/wasm/jit/ir/expressions/canonicalize.js";
import { exprsEqual } from "#backends/wasm/jit/ir/expressions/equality.js";
import {
  bitsUse,
  childUseForExpr,
  exactUse,
  exprUseSatisfies,
  full32Use
} from "#backends/wasm/jit/ir/expressions/uses.js";

test("JitScalarExpr semantic projection constants canonicalize without consumer metadata", () => {
  deepStrictEqual(
    canonicalizeExpr(exprProject(8, exprConst(0x1234_5678))),
    exprConst(0x78)
  );
});

test("JitScalarExpr nested projections collapse only to identical semantics", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const nested = exprProject(16, exprProject(8, eax));
  const expected = exprProject(8, eax);

  deepStrictEqual(canonicalizeExpr(nested), expected);
  strictEqual(exprsEqual(canonicalizeExpr(nested), expected), true);
});

test("JitScalarExpr high-mask demand through low projection observes no input bits", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const projected = exprProject(8, eax);

  deepStrictEqual(childUseForExpr(projected, 0, bitsUse(0xff00)), bitsUse(0));
  deepStrictEqual(exprDependencies(projected, bitsUse(0xff00)), []);
});

test("JitScalarExpr aliases derive from canonical register inputs", () => {
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

test("JitScalarExpr flag inputs are per-flag cells", () => {
  const zf = exprInput({ kind: "flag", flag: "ZF" });

  deepStrictEqual(exprDependencies(zf), [
    { kind: "flag", flag: "ZF" }
  ]);
  deepStrictEqual(exprDependencies(zf, bitsUse(0)), []);
});

test("JitScalarExpr canonicalization keeps arithmetic and condition shapes", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const addZero = exprBinary("add", eax, exprConst(0));
  const selfCompare = exprCompare("eq", eax, eax);
  const constSelect = exprSelect(exprConst(1), eax, ebx);

  deepStrictEqual(canonicalizeExpr(addZero), addZero);
  deepStrictEqual(canonicalizeExpr(selfCompare), selfCompare);
  deepStrictEqual(canonicalizeExpr(constSelect), constSelect);
});

test("JitScalarExpr equality keeps semantic projections separate from partial uses", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const projected = exprProject(8, eax);

  strictEqual(exprsEqual(canonicalizeExpr(projected), canonicalizeExpr(eax)), false);
  strictEqual(exprsEqual(canonicalizeExpr(exprProject(8, exprConst(0x1234_5678))), exprConst(0x78)), true);
  strictEqual(exprsEqual(canonicalizeExpr(exprBinary("add", eax, exprConst(0))), eax), false);
});

test("JitScalarExpr partial materialization cannot satisfy full semantic reuse", () => {
  strictEqual(exprUseSatisfies(bitsUse(0xff), full32Use()), false);
  strictEqual(exprUseSatisfies(bitsUse(0xff), exactUse()), false);
  strictEqual(exprUseSatisfies(full32Use(), bitsUse(0xff)), true);
});

test("JitScalarExpr insertion demand splits between preserved and inserted bits", () => {
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

test("JitScalarExpr dependencies merge repeated register inputs structurally", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const combined = exprBinary("or", exprProject(8, eax), exprBits(eax, 8, 8));

  deepStrictEqual(exprDependencies(combined), [
    { kind: "reg", reg: "eax", mask: 0xffff }
  ]);
});

test("JitScalarExpr canonicalization removes no-op alias insertions", () => {
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(canonicalizeExpr(exprInsertBits(eax, exprProject(8, eax), 0, 8)), eax);
  deepStrictEqual(canonicalizeExpr(exprInsertBits(eax, exprBits(eax, 8, 8), 8, 8)), eax);
});
