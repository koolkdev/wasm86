import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type { IrExprBlock, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { buildJitInstructionValueTimeline } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import {
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import type { Reg32 } from "#x86/isa/types.js";

test("JIT value timeline records the same register source expression before and after a write", () => {
  const entry = createJitValueState();
  const eaxSource = source(reg("eax"));
  const expressionBlock = [
    { op: "let32", dst: v(0), value: eaxSource },
    { op: "set", target: reg("eax"), value: c32(7), accessWidth: 32 },
    { op: "let32", dst: v(1), value: eaxSource }
  ] as const satisfies IrExprBlock;

  entry.regs.writeReg32("eax", c32(3));

  const timeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: entry.snapshot()
  });

  deepStrictEqual(
    timeline.placedExpressionValues
      .filter((fact) => fact.expression === eaxSource)
      .map(({ expressionOpIndex, value }) => ({ expressionOpIndex, value })),
    [
      { expressionOpIndex: 0, value: c32(3) },
      { expressionOpIndex: 2, value: c32(7) }
    ]
  );
  deepStrictEqual(timeline.valueRefValuesByExpressionOpIndex[0]?.get(0), c32(3));
  deepStrictEqual(timeline.valueRefValuesByExpressionOpIndex[2]?.get(1), c32(7));
  deepStrictEqual(timeline.placedValueRefValues, [
    { expressionOpIndex: 0, valueRef: v(0), value: c32(3) },
    { expressionOpIndex: 2, valueRef: v(1), value: c32(7) }
  ]);
  deepStrictEqual(timeline.placedStorageReads, [
    { expressionOpIndex: 0, source: reg("eax"), accessWidth: 32, signed: false, value: c32(3) },
    { expressionOpIndex: 2, source: reg("eax"), accessWidth: 32, signed: false, value: c32(7) }
  ]);
  deepStrictEqual(timeline.logicalWrites, [{
    expressionOpIndex: 1,
    slot: { kind: "reg32", reg: "eax" },
    value: c32(7)
  }]);
  deepStrictEqual(timeline.finalValueState.regs.readReg32("eax"), c32(7));
});

test("JIT value timeline records partial register writes as full-register inserts", () => {
  const expressionBlock = [
    { op: "set", target: reg("eax"), value: c32(0x7f), accessWidth: 8 }
  ] as const satisfies IrExprBlock;
  const timeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: createJitValueState().snapshot()
  });
  const expected = jitInsertBits(jitInputReg32Value("eax"), c32(0x7f), 0, 8);

  deepStrictEqual(timeline.logicalWrites, [{
    expressionOpIndex: 0,
    slot: { kind: "reg32", reg: "eax" },
    value: expected
  }]);
  deepStrictEqual(timeline.finalValueState.regs.readReg32("eax"), expected);
});

test("JIT value timeline records condition reads before and after flag writes", () => {
  const eax = jitInputReg32Value("eax");
  const result = jitAdd(eax, c32(1));
  const incFlags = jitFlagProducerValue("inc", {
    left: eax,
    result
  }, { mask: FLAG_PRODUCERS.inc.writtenMask });
  const expectedFlags = jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    incFlags,
    FLAG_PRODUCERS.inc.writtenMask
  );
  const condition = { kind: "flags.condition", cc: "E" } as const satisfies IrValueExpr;
  const expressionBlock = [
    { op: "let32", dst: v(0), value: condition },
    { op: "let32", dst: v(1), value: source(reg("eax")) },
    { op: "let32", dst: v(2), value: exprAdd(v(1), c32(1)) },
    {
      op: "flags.set",
      producer: "inc",
      writtenMask: FLAG_PRODUCERS.inc.writtenMask,
      undefMask: 0,
      inputs: {
        left: v(1),
        result: v(2)
      }
    },
    { op: "let32", dst: v(3), value: condition }
  ] as const satisfies IrExprBlock;
  const timeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: createJitValueState().snapshot()
  });

  deepStrictEqual(
    timeline.placedExpressionValues
      .filter((fact) => fact.expression === condition)
      .map(({ expressionOpIndex, value }) => ({ expressionOpIndex, value })),
    [
      { expressionOpIndex: 0, value: jitFlagConditionValue(jitInputAluFlagsValue(), "E") },
      { expressionOpIndex: 4, value: jitFlagConditionValue(expectedFlags, "E") }
    ]
  );
  deepStrictEqual(timeline.logicalWrites, [{
    expressionOpIndex: 3,
    slot: { kind: "aluFlags" },
    value: expectedFlags
  }]);
});

test("JIT value timeline records memory operand effective addresses", () => {
  const entry = createJitValueState();
  const memoryOperand = op(0);
  const operands = [{
    kind: "static.mem",
    ea: {
      kind: "mem",
      base: "eax",
      index: "ecx",
      scale: 4,
      disp: 0x20,
      accessWidth: 32
    }
  }] as const satisfies readonly JitOperandBinding[];
  const expressionBlock = [
    { op: "let32", dst: v(0), value: exprAdd(source(memoryOperand), c32(1)) },
    { op: "set", target: memoryOperand, value: c32(7), accessWidth: 32 }
  ] as const satisfies IrExprBlock;

  entry.regs.writeReg32("eax", c32(3));
  entry.regs.writeReg32("ecx", c32(5));

  const timeline = buildJitInstructionValueTimeline({
    operands,
    expressionBlock,
    entryValueState: entry.snapshot()
  });
  const expectedAddress = jitAdd(jitAdd(c32(3), c32(20)), c32(0x20));

  deepStrictEqual(timeline.placedEffectiveAddressValues, [
    { expressionOpIndex: 0, operand: memoryOperand, value: expectedAddress },
    { expressionOpIndex: 1, operand: memoryOperand, value: expectedAddress }
  ]);
  deepStrictEqual(timeline.effectiveAddressValuesByExpressionOpIndex[0]?.get(0), expectedAddress);
  deepStrictEqual(timeline.effectiveAddressValuesByExpressionOpIndex[1]?.get(0), expectedAddress);
  deepStrictEqual(timeline.placedStorageReads, [{
    expressionOpIndex: 0,
    source: memoryOperand,
    accessWidth: 32,
    signed: false
  }]);
});

test("JIT value timeline ignores no-op flag writes before resolving inputs", () => {
  const timeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock: [{
      op: "flags.set",
      producer: "add",
      writtenMask: 0,
      undefMask: 0,
      inputs: {
        left: v(100),
        right: v(101),
        result: v(102)
      }
    }],
    entryValueState: createJitValueState().snapshot()
  });

  deepStrictEqual(timeline.logicalWrites, []);
  deepStrictEqual(timeline.placedValueRefValues, []);
});

function v(id: number) {
  return { kind: "var" as const, id };
}

function reg(name: Reg32) {
  return { kind: "reg" as const, reg: name };
}

function op(index: number) {
  return { kind: "operand" as const, index };
}

function source(sourceRef: ReturnType<typeof reg> | ReturnType<typeof op>) {
  return {
    kind: "source" as const,
    source: sourceRef,
    accessWidth: 32 as const
  };
}

function c32(value: number): Extract<JitValue, { kind: "const" }> {
  return { kind: "const", type: "i32", value };
}

function jitAdd(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

function exprAdd(a: IrValueExpr, b: IrValueExpr): Extract<IrValueExpr, { kind: "value.binary" }> {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}
