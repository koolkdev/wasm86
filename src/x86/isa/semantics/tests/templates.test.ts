import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildIr } from "#x86/ir/build/builder.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import { aluSemantic, unaryAluSemantic } from "#x86/isa/semantics/alu.js";
import { callSemantic, jccSemantic, jmpSemantic, retImmSemantic } from "#x86/isa/semantics/control.js";
import { cmpSemantic } from "#x86/isa/semantics/cmp.js";
import { leaSemantic } from "#x86/isa/semantics/lea.js";
import { intSemantic, nopSemantic } from "#x86/isa/semantics/misc.js";
import { cmovSemantic, movSemantic } from "#x86/isa/semantics/mov.js";
import { leaveSemantic, popSemantic } from "#x86/isa/semantics/stack.js";
import { testSemantic } from "#x86/isa/semantics/test.js";

const v = (id: number) => ({ kind: "var" as const, id });
const op = (index: number) => ({ kind: "operand" as const, index });
const reg = (reg: "esp") => ({ kind: "reg" as const, reg });
const mem = (address: ReturnType<typeof v>) => ({ kind: "mem" as const, address });
const c32 = (value: number) => ({ kind: "const" as const, type: "i32" as const, value });

test("mov semantic gets source, sets destination, and falls through", () => {
  deepStrictEqual(buildIr(movSemantic()), [
    { op: "get", dst: v(0), source: op(1), accessWidth: 32 },
    { op: "set", target: op(0), value: v(0), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("cmov semantic reads source unconditionally and selects the destination value", () => {
  deepStrictEqual(buildIr(cmovSemantic("E")), [
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
  deepStrictEqual(buildIr(aluSemantic("add", 32)), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: op(1), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: v(1) },
    createIrFlagSetOp("add", { left: v(0), right: v(1), result: v(2) }),
    { op: "set", target: op(0), value: v(2), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("inc semantic sets partial inc flags before destination writeback", () => {
  deepStrictEqual(buildIr(unaryAluSemantic("inc", 32)), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(1), a: v(0), b: c32(1) },
    createIrFlagSetOp("inc", { left: v(0), result: v(1) }),
    { op: "set", target: op(0), value: v(1), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("logical alu semantics set logic flags before destination writeback", () => {
  deepStrictEqual(buildIr(aluSemantic("and", 32)), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: op(1), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "and", dst: v(2), a: v(0), b: v(1) },
    createIrFlagSetOp("logic", { result: v(2) }),
    { op: "set", target: op(0), value: v(2), accessWidth: 32 },
    { op: "next" }
  ]);
  deepStrictEqual(buildIr(aluSemantic("or", 32)), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: op(1), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "or", dst: v(2), a: v(0), b: v(1) },
    createIrFlagSetOp("logic", { result: v(2) }),
    { op: "set", target: op(0), value: v(2), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("cmp semantic subtracts for flags only", () => {
  const program = buildIr(cmpSemantic());

  deepStrictEqual(program, [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: op(1), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "sub", dst: v(2), a: v(0), b: v(1) },
    createIrFlagSetOp("sub", { left: v(0), right: v(1), result: v(2) }),
    { op: "next" }
  ]);
  strictEqual(program.some((op) => op.op === "set"), false);
});

test("test semantic uses value.binary and logic flags", () => {
  deepStrictEqual(buildIr(testSemantic()), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: op(1), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "and", dst: v(2), a: v(0), b: v(1) },
    createIrFlagSetOp("logic", { result: v(2) }),
    { op: "next" }
  ]);
});

test("pop semantic expands to generic stack get/set operations", () => {
  deepStrictEqual(buildIr(popSemantic()), [
    { op: "get", dst: v(0), source: reg("esp"), accessWidth: 32 },
    { op: "get", dst: v(1), source: mem(v(0)), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: c32(4) },
    { op: "set", target: reg("esp"), value: v(2), accessWidth: 32 },
    { op: "set", target: op(0), value: v(1), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("leave semantic reads saved frame before updating esp and ebp", () => {
  deepStrictEqual(buildIr(leaveSemantic()), [
    { op: "get", dst: v(0), source: { kind: "reg", reg: "ebp" }, accessWidth: 32 },
    { op: "get", dst: v(1), source: mem(v(0)), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "add", dst: v(2), a: v(0), b: c32(4) },
    { op: "set", target: reg("esp"), value: v(2), accessWidth: 32 },
    { op: "set", target: { kind: "reg", reg: "ebp" }, value: v(1), accessWidth: 32 },
    { op: "next" }
  ]);
});

test("jmp semantic resolves target value before jumping", () => {
  deepStrictEqual(buildIr(jmpSemantic()), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "jump", target: v(0) }
  ]);
});

test("call semantic resolves target before pushing return address", () => {
  deepStrictEqual(buildIr(callSemantic()), [
    { op: "get", dst: v(0), source: op(0), accessWidth: 32 },
    { op: "get", dst: v(1), source: reg("esp"), accessWidth: 32 },
    { op: "value.binary", type: "i32", operator: "sub", dst: v(2), a: v(1), b: c32(4) },
    { op: "set", target: mem(v(2)), value: { kind: "nextEip" }, accessWidth: 32 },
    { op: "set", target: reg("esp"), value: v(2), accessWidth: 32 },
    { op: "jump", target: v(0) }
  ]);
});

test("ret imm semantic adjusts esp explicitly after popping target", () => {
  deepStrictEqual(buildIr(retImmSemantic()), [
    { op: "get", dst: v(0), source: reg("esp"), accessWidth: 32 },
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
