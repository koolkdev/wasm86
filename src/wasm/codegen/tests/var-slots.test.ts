import { strictEqual } from "node:assert";
import { test } from "node:test";

import { assignIrExprVarSlots } from "#wasm/codegen/var-slots.js";

const v = (id: number) => ({ kind: "var" as const, id });
const reg = (reg: "eax" | "ebx") => ({ kind: "reg" as const, reg });
const c32 = (value: number) => ({ kind: "const" as const, type: "i32" as const, value });
const setReg = (target: ReturnType<typeof reg>, value: ReturnType<typeof v> | ReturnType<typeof c32> | Readonly<{
  kind: "value.binary";
  type: "i32";
  operator: "add";
  a: ReturnType<typeof v>;
  b: ReturnType<typeof v> | ReturnType<typeof c32>;
}>) => ({ op: "set" as const, target, value, accessWidth: 32 as const });

test("assignIrExprVarSlots reuses slots after last use", () => {
  const slots = assignIrExprVarSlots([
    { op: "let32", dst: v(0), value: c32(1) },
    setReg(reg("eax"), v(0)),
    { op: "let32", dst: v(1), value: c32(2) },
    setReg(reg("ebx"), v(1)),
    { op: "next" }
  ]);

  strictEqual(slots.slotCount, 1);
  strictEqual(slots.slotByVar.get(0), 0);
  strictEqual(slots.slotByVar.get(1), 0);
});

test("assignIrExprVarSlots can reuse a last-use input slot for a let destination", () => {
  const slots = assignIrExprVarSlots([
    { op: "let32", dst: v(0), value: c32(1) },
    { op: "let32", dst: v(1), value: { kind: "value.binary", type: "i32", operator: "add", a: v(0), b: c32(2) } },
    setReg(reg("eax"), v(1)),
    { op: "next" }
  ]);

  strictEqual(slots.slotCount, 1);
  strictEqual(slots.slotByVar.get(0), 0);
  strictEqual(slots.slotByVar.get(1), 0);
});

test("assignIrExprVarSlots keeps overlapping values in separate slots", () => {
  const slots = assignIrExprVarSlots([
    { op: "let32", dst: v(0), value: c32(1) },
    { op: "let32", dst: v(1), value: c32(2) },
    setReg(reg("eax"), { kind: "value.binary", type: "i32", operator: "add", a: v(0), b: v(1) }),
    { op: "next" }
  ]);

  strictEqual(slots.slotCount, 2);
  strictEqual(slots.slotByVar.get(0), 0);
  strictEqual(slots.slotByVar.get(1), 1);
});
