import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type { IrExprBlock, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { JitSourceValueMap } from "#backends/wasm/jit/codegen/plan/value-state-builder.js";
import {
  buildJitInstructionValueTimeline,
  JitTimelineOpContext
} from "#backends/wasm/jit/codegen/plan/value-timeline.js";
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

test("JIT source-state values and value timeline resolve overlapping values the same way", () => {
  const eax = c32(0x1234_5678);
  const ecx = c32(5);
  const flags = c32(0x40);
  const registerValues = new Map<Reg32, JitValue>([
    ["eax", eax],
    ["ecx", ecx]
  ]);
  const operands = [
    { kind: "static.reg", alias: { name: "ah", base: "eax", bitOffset: 8, width: 8 } },
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
  const instruction = {
    instructionId: "resolver-overlap",
    eip: 0x1000,
    nextEip: 0x1001,
    nextMode: "exit",
    operands,
    ir: []
  } as const;
  const sourceValues = new JitSourceValueMap();

  sourceValues.recordOp({ op: "get", dst: v(0), source: op(0), accessWidth: 8 }, instruction, registerValues);
  sourceValues.recordOp({ op: "address", dst: v(1), operand: op(1) }, instruction, registerValues);

  const entry = createJitValueState();
  entry.regs.writeReg32("eax", eax);
  entry.regs.writeReg32("ecx", ecx);
  entry.flags.writeAluFlags(flags);

  const condition = { kind: "flags.condition", cc: "E" } as const satisfies IrValueExpr;
  const expressionBlock = [
    { op: "let32", dst: v(0), value: source(op(0), 8) },
    { op: "let32", dst: v(1), value: { kind: "address", operand: op(1) } },
    { op: "let32", dst: v(2), value: condition }
  ] as const satisfies IrExprBlock;
  const timeline = buildJitInstructionValueTimeline({
    operands,
    expressionBlock,
    entryValueState: entry.snapshot()
  });

  deepStrictEqual(sourceValues.valueFor(v(0)), timeline.valueRefValuesByExpressionOpIndex[0]?.get(0));
  deepStrictEqual(sourceValues.valueFor(v(1)), timeline.valueRefValuesByExpressionOpIndex[1]?.get(1));
  deepStrictEqual(entry.snapshot().flags.condition("E"), timeline.valueRefValuesByExpressionOpIndex[2]?.get(2));
});

test("JIT timeline op context reads planned effective-address facts only", () => {
  const operands = [{
    kind: "static.mem",
    ea: {
      kind: "mem",
      base: "eax",
      scale: 1,
      disp: 4,
      accessWidth: 32
    }
  }] as const satisfies readonly JitOperandBinding[];
  const expressionBlock = [
    { op: "let32", dst: v(0), value: c32(1) },
    { op: "let32", dst: v(1), value: { kind: "address", operand: op(0) } }
  ] as const satisfies IrExprBlock;
  const timeline = buildJitInstructionValueTimeline({
    operands,
    expressionBlock,
    entryValueState: createJitValueState().snapshot()
  });

  deepStrictEqual(new JitTimelineOpContext(timeline, 0).valueForEffectiveAddress(op(0)), undefined);
  deepStrictEqual(
    new JitTimelineOpContext(timeline, 1).valueForEffectiveAddress(op(0)),
    timeline.effectiveAddressValuesByExpressionOpIndex[1]?.get(0)
  );
});

test("JIT timeline op context reads planned register-storage facts only", () => {
  const entry = createJitValueState();
  entry.regs.writeReg32("eax", c32(3));
  const expressionBlock = [
    { op: "let32", dst: v(0), value: c32(1) },
    { op: "let32", dst: v(1), value: source(reg("eax")) }
  ] as const satisfies IrExprBlock;
  const timeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: entry.snapshot()
  });

  deepStrictEqual(new JitTimelineOpContext(timeline, 0).valueForRegisterStorageRead(reg("eax"), 32, false), undefined);
  deepStrictEqual(new JitTimelineOpContext(timeline, 1).valueForRegisterStorageRead(reg("eax"), 32, false), c32(3));
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

function source(sourceRef: ReturnType<typeof reg> | ReturnType<typeof op>, accessWidth = 32) {
  return {
    kind: "source" as const,
    source: sourceRef,
    accessWidth: accessWidth as 8 | 16 | 32
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
