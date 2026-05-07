import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { registerAlias } from "#x86/isa/registers.js";
import type { IrBlock } from "#x86/ir/model/types.js";
import { runJitOptimizationPasses } from "#backends/wasm/jit/optimization/pass.js";
import {
  propagateJitRegisterValues,
  registerValuePropagationPass
} from "#backends/wasm/jit/optimization/passes/register-value-propagation.js";
import { c32, syntheticInstruction, v } from "./helpers.js";

test("register-value-propagation folds register reads and materializes before exits", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 7 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0) },
        { op: "get", dst: v(1), source: { kind: "reg", reg: "eax" } },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  deepStrictEqual(result.registerValuePropagation, {
    removedSetCount: 1,
    foldedReadCount: 1,
    foldedAddressCount: 0,
    materializedSetCount: 1
  });
  deepStrictEqual(opNames(result.block), ["value.const", "value.const", "set:registerMaterialization", "next"]);
});

test("register-value-propagation inserts materialization before pre-instruction fault points", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 7 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0) },
        { op: "next" }
      ]),
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "mem", address: c32(0x2000) } },
        { op: "next" }
      ], 1, "exit")
    ]
  });

  deepStrictEqual(opNames({ instructions: [result.block.instructions[1]!] }), [
    "set:registerMaterialization",
    "get",
    "next"
  ]);
  strictEqual(result.registerValuePropagation.materializedSetCount, 1);
});

test("register-value-propagation materializes dependencies before clobbers", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(0) },
        { op: "value.const", type: "i32", dst: v(1), value: 0 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(1) },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  deepStrictEqual(opNames(result.block), ["get", "value.const", "set:registerMaterialization", "set", "next"]);
  deepStrictEqual(setRegs(result.block), ["ebx", "eax"]);
  strictEqual(result.registerValuePropagation.removedSetCount, 1);
  strictEqual(result.registerValuePropagation.materializedSetCount, 1);
});

test("register-value-propagation preserves register swap ordering", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "get", dst: v(1), source: { kind: "reg", reg: "ebx" } },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(1) },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(0) },
        { op: "next" }
      ], 0, "exit")
    ]
  });
  const sets = result.block.instructions[0]!.ir.flatMap((op) => op.op === "set" ? [op] : []);

  deepStrictEqual(result.registerValuePropagation, {
    removedSetCount: 1,
    foldedReadCount: 0,
    foldedAddressCount: 0,
    materializedSetCount: 1
  });
  deepStrictEqual(opNames(result.block), [
    "get",
    "get",
    "set:registerMaterialization",
    "set",
    "next"
  ]);
  deepStrictEqual(setRegs(result.block), ["eax", "ebx"]);
  deepStrictEqual(sets.map((op) => op.value), [v(1), v(0)]);
});

test("register-value-propagation folds low-byte reads from tracked full registers", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 0x1234_5678 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0) },
        { op: "get", dst: v(1), source: { kind: "reg", reg: "eax" }, accessWidth: 8 },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 8 },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  deepStrictEqual(result.registerValuePropagation, {
    removedSetCount: 1,
    foldedReadCount: 1,
    foldedAddressCount: 0,
    materializedSetCount: 1
  });
  deepStrictEqual(opNames(result.block), ["value.const", "value.const", "set", "set:registerMaterialization", "next"]);
});

test("register-value-propagation keeps signed and unsigned low-byte reads distinct", () => {
  const propagateLowByteRead = (signed: boolean) => propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "ecx" } },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0) },
        {
          op: "get",
          dst: v(1),
          source: { kind: "reg", reg: "eax" },
          accessWidth: 8,
          ...(signed ? { signed: true as const } : {})
        },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1) },
        { op: "next" }
      ], 0, "exit")
    ]
  });
  const unsignedResult = propagateLowByteRead(false);
  const signedResult = propagateLowByteRead(true);

  strictEqual(unsignedResult.registerValuePropagation.foldedReadCount, 1);
  strictEqual(signedResult.registerValuePropagation.foldedReadCount, 1);
  strictEqual(countOps(unsignedResult.block, "get"), 1);
  strictEqual(countOps(signedResult.block, "get"), 1);
  strictEqual(countOps(unsignedResult.block, "value.binary:and"), 1);
  strictEqual(countOps(signedResult.block, "value.binary:and"), 1);
  strictEqual(countOps(unsignedResult.block, "value.unary:extend8_s"), 0);
  strictEqual(countOps(signedResult.block, "value.unary:extend8_s"), 1);
  deepStrictEqual(setRegs(unsignedResult.block), ["ebx", "eax"]);
  deepStrictEqual(setRegs(signedResult.block), ["ebx", "eax"]);
});

test("register-value-propagation folds high-byte aliases through an unsigned shift", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      withRegisterAliases(
        syntheticInstruction([
          { op: "get", dst: v(0), source: { kind: "reg", reg: "ecx" } },
          { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0) },
          { op: "get", dst: v(1), source: { kind: "operand", index: 0 }, accessWidth: 8 },
          { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 8 },
          { op: "next" }
        ], 0, "exit"),
        ["ah"]
      )
    ]
  });

  deepStrictEqual(result.registerValuePropagation, {
    removedSetCount: 1,
    foldedReadCount: 1,
    foldedAddressCount: 0,
    materializedSetCount: 1
  });
  deepStrictEqual(opNames(result.block), [
    "get",
    "value.binary:shr_u",
    "value.binary:and",
    "set",
    "set:registerMaterialization",
    "next"
  ]);
});

test("register-value-propagation does not fold unrelated partial prefixes", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      withRegisterAliases(
        syntheticInstruction([
          { op: "value.const", type: "i32", dst: v(0), value: 0x12 },
          { op: "set", target: { kind: "operand", index: 0 }, value: v(0), accessWidth: 8 },
          { op: "get", dst: v(1), source: { kind: "operand", index: 1 }, accessWidth: 8 },
          { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 8 },
          { op: "next" }
        ], 0, "exit"),
        ["ah", "al"]
      )
    ]
  });

  deepStrictEqual(result.registerValuePropagation, {
    removedSetCount: 0,
    foldedReadCount: 0,
    foldedAddressCount: 0,
    materializedSetCount: 0
  });
  deepStrictEqual(opNames(result.block), ["value.const", "set", "get", "set", "next"]);
});

test("register-value-propagation folds byte reads from tracked word aliases", () => {
  const low = propagateJitRegisterValues({
    instructions: [
      withRegisterAliases(
        syntheticInstruction([
          { op: "value.const", type: "i32", dst: v(0), value: 0x1234 },
          { op: "set", target: { kind: "operand", index: 0 }, value: v(0), accessWidth: 16 },
          { op: "get", dst: v(1), source: { kind: "operand", index: 1 }, accessWidth: 8 },
          { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 8 },
          { op: "next" }
        ], 0, "exit"),
        ["ax", "al"]
      )
    ]
  });
  const high = propagateJitRegisterValues({
    instructions: [
      withRegisterAliases(
        syntheticInstruction([
          { op: "value.const", type: "i32", dst: v(0), value: 0x1234 },
          { op: "set", target: { kind: "operand", index: 0 }, value: v(0), accessWidth: 16 },
          { op: "get", dst: v(1), source: { kind: "operand", index: 1 }, accessWidth: 8 },
          { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 8 },
          { op: "next" }
        ], 0, "exit"),
        ["ax", "ah"]
      )
    ]
  });

  strictEqual(low.registerValuePropagation.foldedReadCount, 1);
  strictEqual(high.registerValuePropagation.foldedReadCount, 1);
  deepStrictEqual(opNames(low.block), ["value.const", "set", "value.const", "set", "next"]);
  deepStrictEqual(opNames(high.block), ["value.const", "set", "value.const", "set", "next"]);
  deepStrictEqual(constValues(low.block), [0x1234, 0x34]);
  deepStrictEqual(constValues(high.block), [0x1234, 0x12]);
});

test("register-value-propagation does not compose independent byte writes into word reads", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      withRegisterAliases(
        syntheticInstruction([
          { op: "value.const", type: "i32", dst: v(0), value: 0x34 },
          { op: "set", target: { kind: "operand", index: 0 }, value: v(0), accessWidth: 8 },
          { op: "value.const", type: "i32", dst: v(1), value: 0x12 },
          { op: "set", target: { kind: "operand", index: 1 }, value: v(1), accessWidth: 8 },
          { op: "get", dst: v(2), source: { kind: "operand", index: 2 }, accessWidth: 16 },
          { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(2), accessWidth: 16 },
          { op: "next" }
        ], 0, "exit"),
        ["al", "ah", "ax"]
      )
    ]
  });

  strictEqual(result.registerValuePropagation.foldedReadCount, 0);
  deepStrictEqual(opNames(result.block), ["value.const", "set", "value.const", "set", "get", "set", "next"]);
});

test("register-value-propagation does not fold full reads from stale full values after partial writes", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "ecx" } },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0) },
        { op: "value.const", type: "i32", dst: v(1), value: 0x34 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(1), accessWidth: 8 },
        { op: "get", dst: v(2), source: { kind: "reg", reg: "eax" } },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(2) },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  strictEqual(result.registerValuePropagation.foldedReadCount, 0);
  strictEqual(countOps(result.block, "get"), 2);
});

test("register-value-propagation folds partial prefix values across selected clobbers", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "ecx" } },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0), accessWidth: 8 },
        { op: "value.const", type: "i32", dst: v(1), value: 0 },
        { op: "value.select", type: "i32", dst: v(3), condition: c32(1), whenTrue: v(1), whenFalse: c32(0) },
        { op: "set", target: { kind: "reg", reg: "ecx" }, value: v(3) },
        { op: "get", dst: v(2), source: { kind: "reg", reg: "eax" }, accessWidth: 8 },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(2), accessWidth: 8 },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  strictEqual(result.registerValuePropagation.foldedReadCount, 1);
  strictEqual(result.registerValuePropagation.materializedSetCount, 1);
  deepStrictEqual(opNames(result.block), [
    "get",
    "set",
    "value.const",
    "value.select",
    "value.binary:and",
    "set",
    "set:registerMaterialization",
    "next"
  ]);
});

test("register-value-propagation folds partial prefix values before delayed symbolic clobbers", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "ecx" } },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0), accessWidth: 8 },
        { op: "value.const", type: "i32", dst: v(1), value: 0 },
        { op: "set", target: { kind: "reg", reg: "ecx" }, value: v(1) },
        { op: "get", dst: v(2), source: { kind: "reg", reg: "eax" }, accessWidth: 8 },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(2), accessWidth: 8 },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  strictEqual(result.registerValuePropagation.foldedReadCount, 1);
  strictEqual(result.registerValuePropagation.removedSetCount, 1);
  strictEqual(result.registerValuePropagation.materializedSetCount, 1);
  deepStrictEqual(opNames(result.block), [
    "get",
    "set",
    "value.const",
    "value.binary:and",
    "set",
    "set:registerMaterialization",
    "next"
  ]);
  deepStrictEqual(setRegs(result.block), ["eax", "ebx", "ecx"]);
});

test("register-value-propagation folds same-prefix partial reads without removing partial writes", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 0x44 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0), accessWidth: 8 },
        { op: "get", dst: v(1), source: { kind: "reg", reg: "eax" }, accessWidth: 8 },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 8 },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  deepStrictEqual(result.registerValuePropagation, {
    removedSetCount: 0,
    foldedReadCount: 1,
    foldedAddressCount: 0,
    materializedSetCount: 0
  });
  deepStrictEqual(opNames(result.block), ["value.const", "set", "value.const", "set", "next"]);
  deepStrictEqual(setRegs(result.block), ["eax", "ebx"]);
});

test("register-value-propagation keeps wider reads after partial-only writes conservative", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 0x44 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0), accessWidth: 8 },
        { op: "get", dst: v(1), source: { kind: "reg", reg: "eax" }, accessWidth: 16 },
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(1), accessWidth: 16 },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  deepStrictEqual(result.registerValuePropagation, {
    removedSetCount: 0,
    foldedReadCount: 0,
    foldedAddressCount: 0,
    materializedSetCount: 0
  });
  deepStrictEqual(opNames(result.block), ["value.const", "set", "get", "set", "next"]);
});

test("register-value-propagation keeps high-cost retained expressions symbolic", () => {
  const result = propagateJitRegisterValues({
    instructions: [
      syntheticInstruction([
        ...highCostExpressionOps(0),
        { op: "set", target: { kind: "reg", reg: "ebx" }, value: v(6) },
        { op: "get", dst: v(7), source: { kind: "reg", reg: "ebx" } },
        { op: "set", target: { kind: "reg", reg: "esi" }, value: v(7) },
        { op: "next" }
      ], 0, "exit")
    ]
  });

  deepStrictEqual(result.registerValuePropagation, {
    removedSetCount: 1,
    foldedReadCount: 1,
    foldedAddressCount: 0,
    materializedSetCount: 1
  });
  strictEqual(countOps(result.block, "get"), 3);
  strictEqual(countOps(result.block, "value.binary:or"), 2);
  deepStrictEqual(setRegs(result.block), ["esi", "ebx"]);
});

test("register-value-propagation is a validating repeatable optimization pass", () => {
  const first = runJitOptimizationPasses({
    instructions: [
      syntheticInstruction([
        { op: "value.const", type: "i32", dst: v(0), value: 7 },
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(0) },
        { op: "get", dst: v(1), source: { kind: "reg", reg: "eax" } },
        { op: "next" }
      ], 0, "exit")
    ]
  }, [registerValuePropagationPass], { validate: true });
  const second = runJitOptimizationPasses(first.block, [registerValuePropagationPass], { validate: true });

  strictEqual(first.changed, true);
  deepStrictEqual(first.passes[0]?.stats, {
    removedSetCount: 1,
    foldedReadCount: 1,
    foldedAddressCount: 0,
    materializedSetCount: 1
  });
  strictEqual(second.changed, false);
  deepStrictEqual(second.passes[0]?.stats, {
    removedSetCount: 0,
    foldedReadCount: 0,
    foldedAddressCount: 0,
    materializedSetCount: 0
  });
});

function opNames(block: { instructions: readonly { ir: readonly { op: string; operator?: string; role?: string }[] }[] }): readonly string[] {
  return block.instructions.flatMap((instruction) =>
    instruction.ir.map((op) => {
      if (op.role !== undefined) {
        return `${op.op}:${op.role}`;
      }

      return op.operator === undefined ? op.op : `${op.op}:${op.operator}`;
    })
  );
}

function setRegs(block: { instructions: readonly { ir: readonly { op: string; target?: { kind: string; reg?: string } }[] }[] }): readonly string[] {
  return block.instructions.flatMap((instruction) =>
    instruction.ir.flatMap((op) =>
      op.op === "set" && op.target?.kind === "reg"
        ? [op.target.reg ?? ""]
        : []
    )
  );
}

function constValues(block: { instructions: readonly { ir: readonly { op: string }[] }[] }): readonly number[] {
  return block.instructions.flatMap((instruction) =>
    instruction.ir.flatMap((op) => op.op === "value.const" && "value" in op && typeof op.value === "number"
      ? [op.value]
      : [])
  );
}

function countOps(
  block: { instructions: readonly { ir: readonly { op: string }[] }[] },
  opName: string
): number {
  return opNames(block).filter((op) => op === opName).length;
}

function withRegisterAliases(
  instruction: ReturnType<typeof syntheticInstruction>,
  aliases: readonly Parameters<typeof registerAlias>[0][]
): ReturnType<typeof syntheticInstruction> {
  return {
    ...instruction,
    operands: aliases.map((alias) => ({ kind: "static.reg" as const, alias: registerAlias(alias) }))
  };
}

function highCostExpressionOps(baseId: number): IrBlock {
  return [
    { op: "get", dst: v(baseId), source: { kind: "reg", reg: "eax" } },
    { op: "get", dst: v(baseId + 1), source: { kind: "reg", reg: "ecx" } },
    { op: "value.binary", type: "i32", operator: "add", dst: v(baseId + 2), a: v(baseId), b: c32(1) },
    { op: "value.binary", type: "i32", operator: "add", dst: v(baseId + 3), a: v(baseId + 1), b: c32(2) },
    { op: "value.binary", type: "i32", operator: "xor", dst: v(baseId + 4), a: v(baseId + 2), b: v(baseId + 3) },
    { op: "get", dst: v(baseId + 5), source: { kind: "reg", reg: "edx" } },
    { op: "value.binary", type: "i32", operator: "or", dst: v(baseId + 6), a: v(baseId + 4), b: v(baseId + 5) }
  ];
}
