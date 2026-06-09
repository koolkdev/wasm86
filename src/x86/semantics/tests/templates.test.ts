import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildIr } from "#ir/build/builder.js";
import type { IrBlock, IrOp, StorageRef } from "#ir/model/types.js";
import { aluSemantic, unaryAluSemantic } from "#x86/semantics/alu.js";
import { callSemantic, jccSemantic, jmpSemantic, retImmSemantic } from "#x86/semantics/control.js";
import { cmpSemantic } from "#x86/semantics/cmp.js";
import { leaSemantic } from "#x86/semantics/lea.js";
import { intSemantic, nopSemantic } from "#x86/semantics/misc.js";
import { cmovSemantic, movSemantic } from "#x86/semantics/mov.js";
import { leaveSemantic, popSemantic } from "#x86/semantics/stack.js";
import { testSemantic } from "#x86/semantics/test.js";

const v = (id: number) => ({ kind: "var" as const, id });
const op = (index: number) => ({ kind: "operand" as const, index });
const reg = (reg: "esp") => ({ kind: "reg" as const, reg });
const mem = (address: ReturnType<typeof v>) => ({ kind: "mem" as const, address });
const c32 = (value: number) => ({ kind: "const" as const, type: "i32" as const, value });
const regOperands = (count: number) => ({
  operandInfo: Array.from({ length: count }, () => ({ storage: "reg" as const }))
});

function flagsWriteOp(program: IrBlock): Extract<IrOp, { op: "flags.write" }> {
  const writes = program.filter((irOp) => irOp.op === "flags.write");

  strictEqual(writes.length, 1);
  return writes[0] as Extract<IrOp, { op: "flags.write" }>;
}

function assertFlagsWriteBeforeWriteback(program: IrBlock, target: StorageRef): void {
  const flagsIndex = program.findIndex((irOp) => irOp.op === "flags.write");
  const setIndex = program.findIndex((irOp) => irOp.op === "set");
  const setOp = program[setIndex] as Extract<IrOp, { op: "set" }>;

  flagsWriteOp(program);
  ok(flagsIndex >= 0 && setIndex > flagsIndex);
  deepStrictEqual(setOp.target, target);
  deepStrictEqual(program[program.length - 1], { op: "next" });
}

test("mov semantic gets source, sets destination, and falls through", () => {
  deepStrictEqual(buildIr(movSemantic(), regOperands(2)), [
    { op: "get", dst: v(0), source: op(1), accessWidth: 32 },
    { op: "set", target: op(0), value: v(0), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("cmov semantic reads source unconditionally and selects the destination value", () => {
  deepStrictEqual(buildIr(cmovSemantic("E"), regOperands(2)), [
    { op: "get", dst: v(0), source: op(1), accessWidth: 32 },
    { op: "flags.condition", dst: v(1), cc: "E" },
    { op: "get", dst: v(2), source: op(0), accessWidth: 32 },
    { op: "value.select", type: "i32", dst: v(3), condition: v(1), whenTrue: v(0), whenFalse: v(2) },
    { op: "set", target: op(0), value: v(3), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("nop semantic falls through without side effects", () => {
  deepStrictEqual(buildIr(nopSemantic()), [
    { op: "next" }
  ]);
});

test("int semantic reads the vector and exits to a host trap", () => {
  deepStrictEqual(buildIr(intSemantic()), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "hostTrap", vector: v(0) }
  ]);
});

test("lea semantic computes address without getting the operand value", () => {
  const program = buildIr(leaSemantic());

  deepStrictEqual(program, [
    { op: "address", dst: v(0), operand: op(1) },
    { op: "set", target: op(0), value: v(0), accessWidth: 32 },
    { op: "next" }
  ]);
  strictEqual(program.some((op) => op.op === "get"), false);
});

test("add semantic sets add flags before destination writeback", () => {
  const program = buildIr(aluSemantic("add", 32), regOperands(2));

  deepStrictEqual(program.slice(0, 2), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: op(1), accessWidth: 32 }
  ]);
  assertFlagsWriteBeforeWriteback(program, op(0));
});

test("add semantic guards memory read-modify-write before flags", () => {
  const program = buildIr(aluSemantic("add", 32), {
    operandInfo: [{ storage: "mem" }, { storage: "reg" }]
  });

  deepStrictEqual(program.slice(0, 5), [
    { op: "address", dst: v(0), operand: op(0) },
    { op: "memory.guard", address: v(0), byteLength: 4, access: "read" },
    { op: "memory.guard", address: v(0), byteLength: 4, access: "write" },
    { op: "get", dst: v(1), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(2), source: op(1), accessWidth: 32 }
  ]);
  assertFlagsWriteBeforeWriteback(program, op(0));
});

test("add semantic reuses one runtime rm address for read-write guards", () => {
  const program = buildIr(aluSemantic("add", 32), {
    operandInfo: [{ storage: "regOrMem" }, { storage: "reg" }]
  });

  deepStrictEqual(program.slice(0, 5), [
    { op: "address", dst: v(0), operand: op(0) },
    { op: "memory.guard", address: v(0), byteLength: 4, access: "read" },
    { op: "memory.guard", address: v(0), byteLength: 4, access: "write" },
    { op: "get", dst: v(1), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(2), source: op(1), accessWidth: 32 }
  ]);
  assertFlagsWriteBeforeWriteback(program, op(0));
});

test("mov semantic guards memory source and destination operands explicitly", () => {
  deepStrictEqual(
    buildIr(movSemantic(), {
      operandInfo: [{ storage: "mem" }, { storage: "mem" }]
    }),
    [
      { op: "address", dst: v(0), operand: op(1) },
      { op: "memory.guard", address: v(0), byteLength: 4, access: "read" },
      { op: "get", dst: v(1), source: op(1), accessWidth: 32 },
      { op: "address", dst: v(2), operand: op(0) },
      { op: "memory.guard", address: v(2), byteLength: 4, access: "write" },
      { op: "set", target: op(0), value: v(1), accessWidth: 32 },
      { op: "next" }
    ]
  );
});

test("inc semantic sets partial inc flags before destination writeback", () => {
  const program = buildIr(unaryAluSemantic("inc", 32), regOperands(1));

  deepStrictEqual(program.slice(0, 2), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) }
  ]);
  strictEqual(Object.hasOwn(flagsWriteOp(program).cells, "CF"), false);
  assertFlagsWriteBeforeWriteback(program, op(0));
  deepStrictEqual(program[program.length - 2], {
    op: "set", target: op(0), value: v(1), accessWidth: 32
  });
});

test("logical alu semantics set logic flags before destination writeback", () => {
  for (const operator of ["and", "or"] as const) {
    const program = buildIr(aluSemantic(operator, 32), regOperands(2));

    deepStrictEqual(program.slice(0, 2), [
      { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
      { op: "get", dst: v(1), source: op(1), accessWidth: 32 }
    ]);
    ok(program.some((irOp) => irOp.op === "value.binary" && irOp.operator === operator));
    deepStrictEqual(flagsWriteOp(program).cells.AF, { kind: "undef" });
    assertFlagsWriteBeforeWriteback(program, op(0));
  }
});

test("cmp semantic subtracts for flags only", () => {
  const program = buildIr(cmpSemantic(), regOperands(2));

  deepStrictEqual(program.slice(0, 2), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: op(1), accessWidth: 32 }
  ]);
  ok(program.some((irOp) => irOp.op === "value.binary" && irOp.operator === "sub"));
  ok(flagsWriteOp(program).conditions !== undefined);
  strictEqual(program.some((irOp) => irOp.op === "set"), false);
  deepStrictEqual(program[program.length - 1], { op: "next" });
});

test("test semantic uses value.binary and logic flags", () => {
  const program = buildIr(testSemantic(), regOperands(2));

  deepStrictEqual(program.slice(0, 2), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: op(1), accessWidth: 32 }
  ]);
  ok(program.some((irOp) => irOp.op === "value.binary" && irOp.operator === "and"));
  deepStrictEqual(flagsWriteOp(program).cells.AF, { kind: "undef" });
  strictEqual(program.some((irOp) => irOp.op === "set"), false);
  deepStrictEqual(program[program.length - 1], { op: "next" });
});

test("pop semantic expands to generic stack get/set operations", () => {
  deepStrictEqual(
    buildIr(popSemantic(), {
      operandInfo: [{ storage: "reg" }]
    }),
    [
      { op: "get", dst: v(0), source: reg("esp"), accessWidth: 32 },
      { op: "memory.guard", address: v(0), byteLength: 4, access: "read" },
      { op: "get", dst: v(1), source: mem(v(0)), accessWidth: 32 },
      { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: c32(4) },
      { op: "set", target: reg("esp"), value: v(2), accessWidth: 32 },
      { op: "set", target: op(0), value: v(1), accessWidth: 32 },
      { op: "next" }
    ]
  );
});

test("pop semantic captures a memory destination address once", () => {
  deepStrictEqual(
    buildIr(popSemantic(), {
      operandInfo: [{ storage: "mem" }]
    }),
    [
      { op: "address", dst: v(0), operand: op(0) },
      { op: "memory.guard", address: v(0), byteLength: 4, access: "write" },
      { op: "get", dst: v(1), source: reg("esp"), accessWidth: 32 },
      { op: "memory.guard", address: v(1), byteLength: 4, access: "read" },
      { op: "get", dst: v(2), source: mem(v(1)), accessWidth: 32 },
      { op: "value.binary", type: "i32", operator: "add", dst: v(3), a: v(1), b: c32(4) },
      { op: "set", target: reg("esp"), value: v(3), accessWidth: 32 },
      { op: "set", target: mem(v(0)), value: v(2), accessWidth: 32 },
      { op: "next" }
    ]
  );
});

test("leave semantic reads saved frame before updating esp and ebp", () => {
  deepStrictEqual(buildIr(leaveSemantic()), [
    { op: "get", dst: v(0), source: { kind: "reg", reg: "ebp" }, accessWidth: 32 },
    { op: "memory.guard", address: v(0), byteLength: 4, access: "read" },
    { op: "get", dst: v(1), source: mem(v(0)), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: c32(4) },
    { op: "set", target: reg("esp"), value: v(2), accessWidth: 32 },
    { op: "set", target: { kind: "reg", reg: "ebp" }, value: v(1), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("jmp semantic resolves target value before jumping", () => {
  deepStrictEqual(buildIr(jmpSemantic(), regOperands(1)), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "jump", target: v(0) }
  ]);
});

test("call semantic resolves target before pushing return address", () => {
  deepStrictEqual(
    buildIr(callSemantic(), {
      operandInfo: [{ storage: "reg" }]
    }),
    [
      { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
      { op: "get", dst: v(1), source: reg("esp"), accessWidth: 32 },
      { op: "value.binary", type: "i32", operator: "sub", dst: v(2), a: v(1), b: c32(4) },
      { op: "memory.guard", address: v(2), byteLength: 4, access: "write" },
      { op: "set", target: mem(v(2)), value: { kind: "nextEip" }, accessWidth: 32 },
      { op: "set", target: reg("esp"), value: v(2), accessWidth: 32 },
      { op: "jump", target: v(0) }
    ]
  );
});

test("ret imm semantic adjusts esp explicitly after popping target", () => {
  deepStrictEqual(buildIr(retImmSemantic()), [
    { op: "get", dst: v(0), source: reg("esp"), accessWidth: 32 },
    { op: "memory.guard", address: v(0), byteLength: 4, access: "read" },
    { op: "get", dst: v(1), source: mem(v(0)), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: c32(4) },
    { op: "set", target: reg("esp"), value: v(2), accessWidth: 32 },
    { op: "get", dst: v(3), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(4), source: reg("esp"), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(5), a: v(4), b: v(3) },
    { op: "set", target: reg("esp"), value: v(5), accessWidth: 32 },
    { op: "jump", target: v(1) }
  ]);
});

test("jcc semantic resolves relative target value before conditional jump", () => {
  deepStrictEqual(buildIr(jccSemantic("NE")), [
    { op: "flags.condition", dst: v(0), cc: "NE" },
    { op: "get", dst: v(1), source: op(0), accessWidth: 32 },
    {
      op: "conditionalJump",
      condition: v(0),
      taken: v(1),
      notTaken: { kind: "nextEip" }
    }
  ]);
});
