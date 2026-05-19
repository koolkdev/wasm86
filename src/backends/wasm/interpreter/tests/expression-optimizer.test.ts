import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type { IrExprBlock, IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { optimizeInterpreterExpressionBlock } from "#backends/wasm/interpreter/codegen/expressions.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";

const v = (id: number) => ({ kind: "var" as const, id });
const op = (index: number) => ({ kind: "operand" as const, index });
const reg = (reg: "eax" | "ebx") => ({ kind: "reg" as const, reg });
const c32 = (value: number) => ({ kind: "const" as const, type: "i32" as const, value });
const sourceValue = (source: ReturnType<typeof op> | ReturnType<typeof reg>) => ({
  kind: "source" as const,
  source,
  accessWidth: 32 as const
});
const binaryAdd = (
  a: IrValueExpr,
  b: IrValueExpr
) => ({ kind: "value.binary" as const, type: "i32" as const, operator: "add" as const, a, b });
const set = (
  target: IrStorageExpr,
  value: IrValueExpr
) => ({ op: "set" as const, target, value, accessWidth: 32 as const });

test("interpreter expression optimizer inlines cheap single-use source reads", () => {
  deepStrictEqual(
    optimize([
      { op: "let32", dst: v(0), value: sourceValue(op(1)) },
      set(op(0), v(0)),
      { op: "next" }
    ]),
    [
      set(op(0), sourceValue(op(1))),
      { op: "next" }
    ]
  );
});

test("interpreter expression optimizer keeps source reads before aliasing writes", () => {
  deepStrictEqual(
    optimize([
      { op: "let32", dst: v(0), value: sourceValue(op(0)) },
      { op: "let32", dst: v(1), value: sourceValue(op(1)) },
      set(reg("eax"), v(1)),
      set(op(1), v(0)),
      { op: "next" }
    ]),
    [
      { op: "let32", dst: v(0), value: sourceValue(op(0)) },
      set(reg("eax"), sourceValue(op(1))),
      set(op(1), v(0)),
      { op: "next" }
    ]
  );
});

test("interpreter expression optimizer does not inline source reads into flag inputs", () => {
  deepStrictEqual(
    optimize([
      { op: "let32", dst: v(0), value: sourceValue(op(0)) },
      { op: "let32", dst: v(1), value: binaryAdd(v(0), c32(1)) },
      createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
      { op: "next" }
    ]),
    [
      { op: "let32", dst: v(0), value: sourceValue(op(0)) },
      { op: "let32", dst: v(1), value: binaryAdd(v(0), c32(1)) },
      createIrFlagSetOp("add", { left: v(0), right: c32(1), result: v(1) }),
      { op: "next" }
    ]
  );
});

function optimize(block: IrExprBlock): IrExprBlock {
  return optimizeInterpreterExpressionBlock(block, {
    canInlineGet: (source) => source.kind !== "mem",
    storageMayAlias: (write, read) =>
      write.kind === "reg" &&
      write.reg === "eax" &&
      read.kind === "operand" &&
      read.index === 0
  });
}
