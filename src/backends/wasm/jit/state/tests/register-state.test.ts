import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  exprBits,
  exprConst,
  exprInsertBits,
  exprProject
} from "#backends/wasm/jit/ir/expressions/builders.js";
import {
  changedRegisterCells,
  initialRegisterState,
  readRegisterAlias,
  type RegisterState,
  registerInputExpr,
  writeRegisterAlias
} from "#backends/wasm/jit/state/register-state.js";
import { registerAlias } from "#x86/isa/registers.js";

test("JIT register state reads aliases from the base register input", () => {
  const state = initialRegisterState();
  const eax = registerInputExpr("eax");

  deepStrictEqual(readRegisterAlias(state, registerAlias("eax")), eax);
  deepStrictEqual(readRegisterAlias(state, registerAlias("ax")), exprProject(16, eax));
  deepStrictEqual(readRegisterAlias(state, registerAlias("al")), exprProject(8, eax));
  deepStrictEqual(readRegisterAlias(state, registerAlias("ah")), exprBits(eax, 8, 8));
});

test("JIT register state writes AL while preserving AH and the high word", () => {
  const state = initialRegisterState();
  const eax = registerInputExpr("eax");
  const next = writeRegisterAlias(state, registerAlias("al"), exprConst(0x12));
  const expectedEax = exprInsertBits(eax, exprConst(0x12), 0, 8);

  deepStrictEqual(readRegisterAlias(next, registerAlias("eax")), expectedEax);
  deepStrictEqual(readRegisterAlias(next, registerAlias("ah")), exprBits(expectedEax, 8, 8));
});

test("JIT register state writes AH while preserving AL and the high word", () => {
  const state = initialRegisterState();
  const eax = registerInputExpr("eax");
  const next = writeRegisterAlias(state, registerAlias("ah"), exprConst(0x34));
  const expectedEax = exprInsertBits(eax, exprConst(0x34), 8, 8);

  deepStrictEqual(readRegisterAlias(next, registerAlias("eax")), expectedEax);
  deepStrictEqual(readRegisterAlias(next, registerAlias("al")), exprProject(8, expectedEax));
});

test("JIT register state writes AX while preserving the high word", () => {
  const state = initialRegisterState();
  const eax = registerInputExpr("eax");
  const next = writeRegisterAlias(state, registerAlias("ax"), exprConst(0x1234));
  const expectedEax = exprInsertBits(eax, exprConst(0x1234), 0, 16);

  deepStrictEqual(readRegisterAlias(next, registerAlias("eax")), expectedEax);
  deepStrictEqual(readRegisterAlias(next, registerAlias("ax")), exprProject(16, expectedEax));
});

test("JIT register state detects alias no-op writes against the current alias value", () => {
  const state = initialRegisterState();
  const narrowedEax = writeRegisterAlias(
    state,
    registerAlias("eax"),
    exprProject(16, registerInputExpr("eax"))
  );
  const same = writeRegisterAlias(
    narrowedEax,
    registerAlias("al"),
    readRegisterAlias(narrowedEax, registerAlias("al"))
  );

  strictEqual(same, narrowedEax);
});

test("JIT register state full EAX writes replace all aliases", () => {
  const state = initialRegisterState();
  const withLowByte = writeRegisterAlias(state, registerAlias("al"), exprConst(0x7f));
  const ebx = registerInputExpr("ebx");
  const replaced = writeRegisterAlias(withLowByte, registerAlias("eax"), ebx);

  deepStrictEqual(readRegisterAlias(replaced, registerAlias("eax")), ebx);
  deepStrictEqual(readRegisterAlias(replaced, registerAlias("ax")), exprProject(16, ebx));
  deepStrictEqual(readRegisterAlias(replaced, registerAlias("al")), exprProject(8, ebx));
  deepStrictEqual(readRegisterAlias(replaced, registerAlias("ah")), exprBits(ebx, 8, 8));
});

test("JIT register state reports changed base-register cells against inputs", () => {
  const state = initialRegisterState();
  const changed = writeRegisterAlias(state, registerAlias("eax"), exprConst(1));
  const restored = writeRegisterAlias(changed, registerAlias("eax"), registerInputExpr("eax"));

  deepStrictEqual(changedRegisterCells(state), []);
  deepStrictEqual(changedRegisterCells(changed), [
    { reg: "eax", value: exprConst(1) }
  ]);
  deepStrictEqual(changedRegisterCells(restored), []);
});

test("JIT register state rejects missing base cells", () => {
  const state = { cells: new Map() } satisfies RegisterState;

  throws(
    () => readRegisterAlias(state, registerAlias("eax")),
    /register state is missing base cell eax/
  );
});
