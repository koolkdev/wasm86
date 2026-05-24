import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { reg32 } from "#x86/isa/types.js";
import {
  exprBits,
  exprConst,
  exprInput,
  exprInsertBits,
  exprProject
} from "#backends/wasm/jit/ir/expressions/builders.js";
import { RegisterState } from "#backends/wasm/jit/state/register-state.js";
import { registerAlias } from "#x86/isa/registers.js";

test("JIT register state returns keyed cells for all base registers", () => {
  const state = RegisterState.initial();

  deepStrictEqual(
    state.cells(),
    reg32.map((reg) => ({ reg, value: exprInput({ kind: "reg", reg }) }))
  );
});

test("JIT register state reads aliases from the base register input", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(state.read("eax"), eax);
  deepStrictEqual(state.readAlias(registerAlias("eax")), eax);
  deepStrictEqual(state.readAlias(registerAlias("ax")), exprProject(16, eax));
  deepStrictEqual(state.readAlias(registerAlias("al")), exprProject(8, eax));
  deepStrictEqual(state.readAlias(registerAlias("ah")), exprBits(eax, 8, 8));
});

test("JIT register state writes AL while preserving AH and the high word", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const next = state.writeAlias(registerAlias("al"), exprConst(0x12));
  const expectedEax = exprInsertBits(eax, exprConst(0x12), 0, 8);

  strictEqual(next === state, false);
  deepStrictEqual(state.read("eax"), eax);
  deepStrictEqual(next.readAlias(registerAlias("eax")), expectedEax);
  deepStrictEqual(next.readAlias(registerAlias("ah")), exprBits(expectedEax, 8, 8));
});

test("JIT register state writes AH while preserving AL and the high word", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const next = state.writeAlias(registerAlias("ah"), exprConst(0x34));
  const expectedEax = exprInsertBits(eax, exprConst(0x34), 8, 8);

  deepStrictEqual(state.read("eax"), eax);
  deepStrictEqual(next.readAlias(registerAlias("eax")), expectedEax);
  deepStrictEqual(next.readAlias(registerAlias("al")), exprProject(8, expectedEax));
});

test("JIT register state writes AX while preserving the high word", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const next = state.writeAlias(registerAlias("ax"), exprConst(0x1234));
  const expectedEax = exprInsertBits(eax, exprConst(0x1234), 0, 16);

  deepStrictEqual(state.read("eax"), eax);
  deepStrictEqual(next.readAlias(registerAlias("eax")), expectedEax);
  deepStrictEqual(next.readAlias(registerAlias("ax")), exprProject(16, expectedEax));
});

test("JIT register state detects alias no-op writes against the current alias value", () => {
  const state = RegisterState.initial();
  const narrowedEax = state.write(
    "eax",
    exprProject(16, exprInput({ kind: "reg", reg: "eax" }))
  );
  const same = narrowedEax.writeAlias(
    registerAlias("al"),
    narrowedEax.readAlias(registerAlias("al"))
  );

  strictEqual(same, narrowedEax);
});

test("JIT register state detects base register no-op writes", () => {
  const state = RegisterState.initial();

  strictEqual(state.write("eax", exprInput({ kind: "reg", reg: "eax" })), state);
  strictEqual(
    state.writeAlias(registerAlias("eax"), exprInput({ kind: "reg", reg: "eax" })),
    state
  );
});

test("JIT register state full EAX writes replace all aliases", () => {
  const state = RegisterState.initial();
  const withLowByte = state.writeAlias(registerAlias("al"), exprConst(0x7f));
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const replaced = withLowByte.write("eax", ebx);

  deepStrictEqual(
    withLowByte.read("eax"),
    exprInsertBits(exprInput({ kind: "reg", reg: "eax" }), exprConst(0x7f), 0, 8)
  );
  deepStrictEqual(replaced.readAlias(registerAlias("eax")), ebx);
  deepStrictEqual(replaced.readAlias(registerAlias("ax")), exprProject(16, ebx));
  deepStrictEqual(replaced.readAlias(registerAlias("al")), exprProject(8, ebx));
  deepStrictEqual(replaced.readAlias(registerAlias("ah")), exprBits(ebx, 8, 8));
});

test("JIT register state cells expose final base-register expressions", () => {
  const state = RegisterState.initial();
  const changed = state.writeAlias(registerAlias("eax"), exprConst(1));
  const restored = changed.write("eax", exprInput({ kind: "reg", reg: "eax" }));

  deepStrictEqual(
    changed.cells(),
    reg32.map((reg) => ({
      reg,
      value: reg === "eax" ? exprConst(1) : exprInput({ kind: "reg", reg })
    }))
  );
  deepStrictEqual(
    restored.cells(),
    reg32.map((reg) => ({ reg, value: exprInput({ kind: "reg", reg }) }))
  );
});

test("JIT register state canonicalizes values at write boundaries", () => {
  const state = RegisterState.initial();
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const changed = state.write("eax", exprProject(32, ebx));

  deepStrictEqual(changed.read("eax"), ebx);
});
