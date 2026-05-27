import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type { Reg32 } from "#x86/types.js";
import type { IrValueExpr } from "#wasm/codegen/expressions.js";
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
  const resolver = createJitValueResolver({});
  const eax = jitInputReg32Value("eax");
  const lowByte = jitExtractBits(eax, 0, 8);

  deepStrictEqual(
    resolver.valueForStorage({ kind: "reg", reg: "eax" }, 8),
    lowByte
  );
  deepStrictEqual(
    resolver.valueForExpression({
      kind: "value.unary",
      type: "i32",
      operator: "extend8_s",
      value: sourceReg("eax", 8)
    }),
    extend8s(lowByte)
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
  const snapshotResolver = createJitValueResolver({
    readReg32: (reg) => snapshot.regs.readReg32(reg)
  });
  const callbackResolver = createJitValueResolver({
    readReg32: (reg) => callbackValues.get(reg) ?? jitInputReg32Value(reg)
  });

  for (const resolver of [snapshotResolver, callbackResolver]) {
    deepStrictEqual(
      resolver.valueForStorage({ kind: "reg", reg: "eax" }),
      currentEax
    );
    deepStrictEqual(
      resolver.valueForStorage({ kind: "reg", reg: "ah" }, 8),
      jitExtractBits(currentEax, 8, 8)
    );
    deepStrictEqual(
      resolver.valueForStorage({ kind: "reg", reg: "ax" }, 16),
      jitExtractBits(currentEax, 0, 16)
    );
    deepStrictEqual(
      resolver.valueForExpression(addExpr(addExpr(sourceReg("eax"), shlExpr(sourceReg("ecx"), c32Expr(2))), c32Expr(0x20))),
      add(add(currentEax, shl(currentEcx, c32(2))), c32(0x20))
    );
  }
});

test("JIT value resolver resolves constants and child expression values", () => {
  const resolver = createJitValueResolver({});
  const source = { kind: "const", type: "i32", value: 0xffff_ffff } as const;
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
  const resolver = createJitValueResolver({});

  deepStrictEqual(
    resolver.valueForExpression({ kind: "flags.condition", cc: "E" }),
    undefined
  );
});

test("JIT value resolver resolves flag conditions from the supplied flag reader", () => {
  const flags = jitInputAluFlagsValue();
  const resolver = createJitValueResolver({
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

function c32Expr(value: number) {
  return { kind: "const" as const, type: "i32" as const, value };
}

function sourceReg(reg: Reg32, accessWidth: 8 | 16 | 32 = 32) {
  return {
    kind: "source" as const,
    source: { kind: "reg" as const, reg },
    accessWidth
  };
}

function addExpr(a: IrValueExpr, b: IrValueExpr): IrValueExpr {
  return { kind: "value.binary" as const, type: "i32" as const, operator: "add" as const, a, b };
}

function shlExpr(a: IrValueExpr, b: IrValueExpr): IrValueExpr {
  return { kind: "value.binary" as const, type: "i32" as const, operator: "shl" as const, a, b };
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
