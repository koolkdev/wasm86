import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import {
  buildIrExpressionBlock
} from "#backends/wasm/codegen/expressions.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";

const v = (id: number) => ({ kind: "var" as const, id });
const op = (index: number) => ({ kind: "operand" as const, index });
const reg = (reg: "eax" | "ebx") => ({ kind: "reg" as const, reg });
const c32 = (value: number) => ({ kind: "const" as const, type: "i32" as const, value });
const mem = (address: ReturnType<typeof v> | ReturnType<typeof c32>) => ({ kind: "mem" as const, address });
const address = (operand: ReturnType<typeof op>) => ({ kind: "address" as const, operand });
const sourceValue = (
  source: ReturnType<typeof op> | ReturnType<typeof reg> | ReturnType<typeof mem>,
  accessWidth: 8 | 16 | 32 = 32,
  signed = false
) => ({
  kind: "source" as const,
  source,
  accessWidth,
  ...(signed ? { signed: true as const } : {})
});
const set = (
  target: ReturnType<typeof op> | ReturnType<typeof reg>,
  value: ReturnType<typeof v> | ReturnType<typeof c32> | ReturnType<typeof sourceValue> | Readonly<{
    kind: "value.binary";
    type: "i32";
    operator: "add" | "sub";
    a: ReturnType<typeof v> | ReturnType<typeof c32> | ReturnType<typeof sourceValue>;
    b: ReturnType<typeof v> | ReturnType<typeof c32> | ReturnType<typeof sourceValue>;
  }>
) => ({ op: "set" as const, target, value, accessWidth: 32 as const });

test("expression selector materializes storage reads before use", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "get", dst: v(0), source: op(1) },
      { op: "set", target: op(0), value: v(0) },
      { op: "next" }
    ]),
    [
      { op: "let32", dst: v(0), value: sourceValue(op(1)) },
      set(op(0), v(0)),
      { op: "next" }
    ]
  );
});

test("expression selector materializes storage reads in source order", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "get", dst: v(0), source: op(0) },
      { op: "get", dst: v(1), source: op(1) },
      { op: "set", target: reg("eax"), value: v(1) },
      { op: "set", target: op(1), value: v(0) },
      { op: "next" }
    ]),
    [
      { op: "let32", dst: v(0), value: sourceValue(op(0)) },
      { op: "let32", dst: v(1), value: sourceValue(op(1)) },
      set(reg("eax"), v(1)),
      set(op(1), v(0)),
      { op: "next" }
    ]
  );
});

test("expression selector preserves signed source reads", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "get", dst: v(0), source: op(1), accessWidth: 8, signed: true },
      { op: "set", target: op(0), value: v(0), accessWidth: 32 },
      { op: "next" }
    ]),
    [
      { op: "let32", dst: v(0), value: sourceValue(op(1), 8, true) },
      set(op(0), v(0)),
      { op: "next" }
    ]
  );
});

test("expression selector folds simple register arithmetic into destination values", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "get", dst: v(0), source: reg("eax") },
      { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
      { op: "set", target: reg("ebx"), value: v(1) },
      { op: "next" }
    ]),
    [
      { op: "let32", dst: v(0), value: sourceValue(reg("eax")) },
      set(reg("ebx"), {
        kind: "value.binary", type: "i32", operator: "add",
        a: v(0),
        b: c32(1)
      }),
      { op: "next" }
    ]
  );
});

test("expression selector can reuse const bindings without a temporary", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "value.const", type: "i32", dst: v(0), value: 7 },
      { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: v(0) },
      { op: "set", target: reg("ebx"), value: v(1) },
      { op: "next" }
    ]),
    [
      {
        ...set(reg("ebx"), {
          kind: "value.binary", type: "i32", operator: "add",
          a: c32(7),
          b: c32(7)
        })
      },
      { op: "next" }
    ]
  );
});

test("expression selector materializes flag inputs that still need value refs", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "get", dst: v(0), source: op(0) },
      { op: "get", dst: v(1), source: op(1) },
      { op: "value.binary", type: "i32", operator: "sub", dst: v(2), a: v(0), b: v(1) },
      createIrFlagSetOp("sub", { left: v(0), right: v(1), result: v(2) }),
      { op: "next" }
    ]),
    [
      { op: "let32", dst: v(0), value: sourceValue(op(0)) },
      { op: "let32", dst: v(1), value: sourceValue(op(1)) },
      { op: "let32", dst: v(2), value: { kind: "value.binary", type: "i32", operator: "sub", a: v(0), b: v(1) } },
      createIrFlagSetOp("sub", { left: v(0), right: v(1), result: v(2) }),
      { op: "next" }
    ]
  );
});

test("expression selector inlines select values into writes", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "get", dst: v(0), source: op(1) },
      { op: "flags.condition", dst: v(1), cc: "E" },
      { op: "value.select", type: "i32", dst: v(2), condition: v(1), whenTrue: v(0), whenFalse: c32(0) },
      { op: "set", target: op(0), value: v(2) },
      { op: "next" }
    ]),
    [
      { op: "let32", dst: v(0), value: sourceValue(op(1)) },
      { op: "let32", dst: v(1), value: { kind: "flags.condition", cc: "E" } },
      {
        op: "set",
        target: op(0),
        value: {
          kind: "value.select",
          type: "i32",
          condition: v(1),
          whenTrue: v(0),
          whenFalse: c32(0)
        },
        accessWidth: 32
      },
      { op: "next" }
    ]
  );
});

test("expression selector materializes condition reads before conditional jumps", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "flags.condition", dst: v(0), cc: "E" },
      { op: "conditionalJump", condition: v(0), taken: c32(0x2000), notTaken: c32(0x1002) }
    ]),
    [
      { op: "let32", dst: v(0), value: { kind: "flags.condition", cc: "E" } },
      { op: "conditionalJump", condition: v(0), taken: c32(0x2000), notTaken: c32(0x1002) }
    ]
  );
});

test("expression selector keeps explicit memory guards", () => {
  deepStrictEqual(
    buildIrExpressionBlock([
      { op: "address", dst: v(0), operand: op(0) },
      { op: "memory.guard", address: v(0), byteLength: 4, access: "read" },
      { op: "memory.guard", address: v(0), byteLength: 4, access: "write" },
      { op: "next" }
    ]),
    [
      { op: "memory.guard", address: address(op(0)), byteLength: 4, access: "read" },
      { op: "memory.guard", address: address(op(0)), byteLength: 4, access: "write" },
      { op: "next" }
    ]
  );
});
