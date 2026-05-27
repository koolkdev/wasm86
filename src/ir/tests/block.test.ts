import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { operand } from "#ir/build/builder.js";
import { IrBlockBuilder } from "#ir/build/block.js";

test("IrBlockBuilder appends instructions with one var namespace", () => {
  const builder = new IrBlockBuilder();
  const first = builder.appendInstruction({
    semantics: (s) => {
      const value = s.get(s.operand(0));

      s.set(s.reg("eax"), value);
    },
    operands: [operand(3)]
  });
  const second = builder.appendInstruction({
    semantics: (s) => {
      s.set(s.operand(1), s.i32Add(s.get(s.operand(0)), 1));
    },
    operands: [operand(8), operand(9)]
  });

  deepStrictEqual(builder.build(), [
    { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "operand", index: 3 }, accessWidth: 32 },
    {
      op: "set",
      target: { kind: "reg", reg: "eax" },
      value: { kind: "var", id: 0 },
      accessWidth: 32
    },
    { op: "next" },
    { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "operand", index: 8 }, accessWidth: 32 },
    {
      op: "value.binary", type: "i32", operator: "add",
      dst: { kind: "var", id: 2 },
      a: { kind: "var", id: 1 },
      b: { kind: "const", type: "i32", value: 1 }
    },
    {
      op: "set",
      target: { kind: "operand", index: 9 },
      value: { kind: "var", id: 2 },
      accessWidth: 32
    },
    { op: "next" }
  ]);
  deepStrictEqual(first, { terminator: "next" });
  deepStrictEqual(second, { terminator: "next" });
});

test("IrBlockBuilder preserves semantic operand metadata through operand remapping", () => {
  const builder = new IrBlockBuilder();

  builder.appendInstruction({
    semantics: (s, context) => {
      const operandInfo = context.operandInfo(s.operand(0));

      s.set(s.reg("eax"), operandInfo.storage === "mem" ? 1 : 0);
    },
    operands: [operand(3)],
    operandInfo: [{ storage: "mem" }]
  });

  deepStrictEqual(builder.build(), [
    {
      op: "set",
      target: { kind: "reg", reg: "eax" },
      value: { kind: "const", type: "i32", value: 1 },
      accessWidth: 32
    },
    { op: "next" }
  ]);
});

test("IrBlockBuilder rejects missing metadata for reconstructed operand refs", () => {
  const builder = new IrBlockBuilder();

  throws(
    () =>
      builder.appendInstruction({
        semantics: (s, context) => {
          s.operand(0);
          context.operandInfo(operand(3));
        },
        operands: [operand(3)],
        operandInfo: [{ storage: "mem" }]
      }),
    /missing semantic operand metadata for operand 3/
  );
});
