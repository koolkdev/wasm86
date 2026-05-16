import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrExprBlock, IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { createJitValueResolver } from "#backends/wasm/jit/analysis/value-resolver.js";
import {
  buildTimeline,
  opView
} from "#backends/wasm/jit/analysis/timeline.js";
import {
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits,
  jitProducedValue
} from "#backends/wasm/jit/ir/values/builders.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
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

  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: entry.snapshot()
  });

  deepStrictEqual(opView(timeline, 0).expression(eaxSource), c32(3));
  deepStrictEqual(opView(timeline, 2).expression(eaxSource), c32(7));
  deepStrictEqual(opView(timeline, 0).ref(v(0)), c32(3));
  deepStrictEqual(opView(timeline, 2).ref(v(1)), c32(7));
  deepStrictEqual(timeline.storageReads, [
    { opIndex: 0, source: reg("eax"), accessWidth: 32, signed: false, value: c32(3) },
    { opIndex: 2, source: reg("eax"), accessWidth: 32, signed: false, value: c32(7) }
  ]);
  deepStrictEqual(timeline.writes, [{
    opIndex: 1,
    slot: { kind: "reg32", reg: "eax" },
    value: c32(7)
  }]);
  deepStrictEqual(timeline.final.regs.readReg32("eax"), c32(7));
});

test("JIT value timeline records partial register writes as named register aliases", () => {
  const expressionBlock = [
    { op: "set", target: reg("eax"), value: c32(0x7f), accessWidth: 8 }
  ] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot()
  });
  const expected = jitInsertBits(jitInputReg32Value("eax"), c32(0x7f), 0, 8);

  deepStrictEqual(timeline.writes, [{
    opIndex: 0,
    slot: { kind: "reg8", reg: "al" },
    value: c32(0x7f)
  }]);
  deepStrictEqual(timeline.final.regs.readReg32("eax"), expected);
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
  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot()
  });

  deepStrictEqual(opView(timeline, 0).expression(condition), jitFlagConditionValue(jitInputAluFlagsValue(), "E"));
  deepStrictEqual(opView(timeline, 4).expression(condition), jitFlagConditionValue(expectedFlags, "E"));
  deepStrictEqual(timeline.writes, [{
    opIndex: 3,
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

  const timeline = buildTimeline({
    operands,
    expressions: expressionBlock,
    entry: entry.snapshot()
  });
  const expectedAddress = jitAdd(jitAdd(c32(3), c32(20)), c32(0x20));

  deepStrictEqual(opView(timeline, 0).address(memoryOperand), expectedAddress);
  deepStrictEqual(opView(timeline, 1).address(memoryOperand), expectedAddress);
  deepStrictEqual(timeline.storageReads, [{
    opIndex: 0,
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
  const timeline = buildTimeline({
    operands,
    expressions: expressionBlock,
    entry: entry.snapshot()
  });
  const resolver = createJitValueResolver({
    operands,
    readReg32: (reg) => registerValues.get(reg) ?? jitInputReg32Value(reg),
    readAluFlags: () => flags
  });

  deepStrictEqual(resolver.valueForExpression(expressionBlock[0].value), opView(timeline, 0).ref(v(0)));
  deepStrictEqual(resolver.valueForExpression(expressionBlock[1].value), opView(timeline, 1).ref(v(1)));
  deepStrictEqual(resolver.valueForExpression(expressionBlock[2].value), opView(timeline, 2).ref(v(2)));
});

test("JIT timeline op view reads planned effective-address lookups only", () => {
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
  const timeline = buildTimeline({
    operands,
    expressions: expressionBlock,
    entry: createJitValueState().snapshot()
  });

  deepStrictEqual(opView(timeline, 0).address(op(0)), undefined);
  deepStrictEqual(
    opView(timeline, 1).address(op(0)),
    opView(timeline, 1).expression(expressionBlock[1].value)
  );
});

test("JIT timeline op view reads planned register-storage lookups only", () => {
  const entry = createJitValueState();
  entry.regs.writeReg32("eax", c32(3));
  const expressionBlock = [
    { op: "let32", dst: v(0), value: c32(1) },
    { op: "let32", dst: v(1), value: source(reg("eax")) }
  ] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: entry.snapshot()
  });

  deepStrictEqual(opView(timeline, 0).storageRead({ source: reg("eax"), accessWidth: 32 }), undefined);
  deepStrictEqual(opView(timeline, 1).storageRead({ source: reg("eax"), accessWidth: 32 }), c32(3));
});

test("JIT timeline records produced memory load definitions at one point", () => {
  const produced = jitProducedValue("load#timeline-test", "i32");
  const expressionBlock = [
    { op: "let32", dst: v(0), value: source({ kind: "mem", address: c32(0x1000) }, 32) },
    { op: "let32", dst: v(1), value: v(0) }
  ] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot(),
    producedByVar: new Map([[0, produced]])
  });

  deepStrictEqual(timeline.produced, [{
    opIndex: 0,
    ref: v(0),
    value: produced
  }]);
  deepStrictEqual(opView(timeline, 0).ref(v(0)), produced);
  deepStrictEqual(opView(timeline, 1).ref(v(1)), produced);
  deepStrictEqual(opView(timeline, 0).expression(expressionBlock[0].value), produced);
});

test("JIT timeline op view fails clearly for invalid op indexes", () => {
  const timeline = buildTimeline({
    operands: [],
    expressions: [{ op: "let32", dst: v(0), value: c32(1) }],
    entry: createJitValueState().snapshot()
  });

  throws(() => opView(timeline, 1), /missing JIT timeline op view for expression op 1/);
});

test("JIT value timeline ignores no-op flag writes before resolving inputs", () => {
  const timeline = buildTimeline({
    operands: [],
    expressions: [{
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
    entry: createJitValueState().snapshot()
  });

  deepStrictEqual(timeline.writes, []);
  deepStrictEqual(opView(timeline, 0).ref(v(100)), undefined);
  deepStrictEqual(opView(timeline, 0).ref(v(101)), undefined);
  deepStrictEqual(opView(timeline, 0).ref(v(102)), undefined);
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

function source(sourceRef: IrStorageExpr, accessWidth = 32) {
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
