import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { registerAlias } from "#x86/isa/registers.js";
import type { Reg32 } from "#x86/isa/types.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import { createJitValueResolver } from "#backends/wasm/jit/analysis/value-resolver.js";
import {
  jitExtractBits,
  jitFlagConditionValue,
  jitInputAluFlagsValue,
  jitInputReg32Value
} from "#backends/wasm/jit/ir/values/builders.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";

test("JIT value resolver reads input register aliases from full-register values", () => {
  const resolver = createJitValueResolver({ operands: [] });
  const eax = jitInputReg32Value("eax");

  deepStrictEqual(
    resolver.valueForStorage({ kind: "reg", reg: "eax" }, 8),
    jitExtractBits(eax, 0, 8)
  );
  deepStrictEqual(
    resolver.valueForStorage({ kind: "reg", reg: "eax" }, 8, true),
    extend8s(jitExtractBits(eax, 0, 8))
  );
});

test("JIT value resolver gives snapshot and callback readers the same aliases and addresses", () => {
  const state = createJitValueState();
  const currentEax = add(jitInputReg32Value("ebx"), c32(4));
  const currentEcx = xor(jitInputReg32Value("edx"), c32(0x10));

  state.regs.writeReg32("eax", currentEax);
  state.regs.writeReg32("ecx", currentEcx);

  const snapshot = state.snapshot();
  const callbackValues = new Map<Reg32, JitValue>([
    ["eax", currentEax],
    ["ecx", currentEcx]
  ]);
  const operands = [
    { kind: "static.reg", alias: registerAlias("ah") },
    { kind: "static.reg", alias: registerAlias("ax") },
    {
      kind: "static.mem",
      ea: {
        kind: "mem",
        base: "eax",
        index: "ecx",
        scale: 4,
        disp: 0x20,
        accessWidth: 32
      }
    }
  ] as const satisfies readonly JitOperandBinding[];
  const snapshotResolver = createJitValueResolver({
    operands,
    readReg32: (reg) => snapshot.regs.readReg32(reg)
  });
  const callbackResolver = createJitValueResolver({
    operands,
    readReg32: (reg) => callbackValues.get(reg) ?? jitInputReg32Value(reg)
  });

  for (const resolver of [snapshotResolver, callbackResolver]) {
    deepStrictEqual(
      resolver.valueForStorage({ kind: "reg", reg: "eax" }),
      currentEax
    );
    deepStrictEqual(
      resolver.valueForStorage({ kind: "operand", index: 0 }, 8),
      jitExtractBits(currentEax, 8, 8)
    );
    deepStrictEqual(
      resolver.valueForStorage({ kind: "operand", index: 1 }, 16),
      jitExtractBits(currentEax, 0, 16)
    );
    deepStrictEqual(
      resolver.valueForEffectiveAddress({ kind: "operand", index: 2 }),
      add(add(currentEax, shl(currentEcx, c32(2))), c32(0x20))
    );
  }
});

test("JIT value resolver resolves immediate and child expression values", () => {
  const resolver = createJitValueResolver({
    operands: [{ kind: "static.imm32", value: 0xff }]
  });
  const source = {
    kind: "source",
    source: { kind: "operand", index: 0 },
    accessWidth: 8,
    signed: true
  } as const;
  const expression = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: source,
    b: { kind: "const", type: "i32", value: 0x12 }
  } as const;

  deepStrictEqual(resolver.valueForExpression(source), c32(-1));
  deepStrictEqual(resolver.valueForExpression(expression), xor(c32(-1), c32(0x12)));
});

test("JIT value resolver resolves value refs inside larger expressions", () => {
  const eax = jitInputReg32Value("eax");
  const resolver = createJitValueResolver({
    operands: [],
    readValueRef: (value) =>
      value.kind === "var" && value.id === 0 ? eax : undefined
  });
  const expression = {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: { kind: "var", id: 0 },
    b: { kind: "const", type: "i32", value: 3 }
  } as const;

  deepStrictEqual(resolver.valueForExpression(expression), add(eax, c32(3)));
});

test("JIT value resolver leaves flag conditions unresolved without a flag reader", () => {
  const resolver = createJitValueResolver({ operands: [] });

  deepStrictEqual(
    resolver.valueForExpression({ kind: "flags.condition", cc: "E" }),
    undefined
  );
});

test("JIT value resolver resolves flag conditions from the supplied flag reader", () => {
  const flags = jitInputAluFlagsValue();
  const resolver = createJitValueResolver({
    operands: [],
    readAluFlags: () => flags
  });

  deepStrictEqual(
    resolver.valueForExpression({ kind: "flags.condition", cc: "E" }),
    jitFlagConditionValue(flags, "E")
  );
});

function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

function add(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

function xor(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "xor", a, b };
}

function shl(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "shl", a, b };
}

function extend8s(value: JitValue): JitValue {
  return { kind: "value.unary", type: "i32", operator: "extend8_s", value };
}
