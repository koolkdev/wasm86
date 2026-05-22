import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  type IrExprBlock,
  type IrStorageExpr,
  type IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import { analyzeBlock } from "#backends/wasm/jit/analysis/block.js";
import { LoadResultRegistry } from "#backends/wasm/jit/analysis/load-result.js";
import { createJitValueResolver } from "#backends/wasm/jit/analysis/value-resolver.js";
import { buildTimeline as buildTimelineWithRegistry } from "#backends/wasm/jit/analysis/timeline-builder.js";
import type { TimelineInput } from "#backends/wasm/jit/analysis/timeline-types.js";
import {
  buildBlockExpressions,
  type BlockExpressions
} from "#backends/wasm/jit/ir/block-expressions.js";
import type { JitBoundExprOp } from "#backends/wasm/jit/ir/bound-expressions.js";
import {
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits,
  jitLoadResultValue
} from "#backends/wasm/jit/ir/values/builders.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import { syntheticInstruction } from "#backends/wasm/jit/ir/tests/helpers.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import type { Reg32 } from "#x86/isa/types.js";

type TestTimelineInput = Omit<TimelineInput, "expressions" | "loadResultRegistry"> & Readonly<{
  expressions: IrExprBlock;
}>;

function buildTimeline(input: TestTimelineInput) {
  const { expressions, ...rest } = input;

  return buildTimelineWithRegistry({
    ...rest,
    expressions: blockExpressionsForTest(expressions),
    loadResultRegistry: new LoadResultRegistry()
  });
}

function blockExpressionsForTest(expressionBlock: IrExprBlock): BlockExpressions {
  return {
    ops: expressionBlock.map((op, opIndex) => ({
      opIndex,
      op: op as JitBoundExprOp,
      progress: {
        instructionCountDelta: 0
      }
    })),
    progress: {
      instructionCountDelta: 0
    }
  };
}

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
    expressions: expressionBlock,
    entry: entry.snapshot(),
    snapshotPoints: new Set()
  });

  deepStrictEqual(timeline.viewAt(0).expression(eaxSource), c32(3));
  deepStrictEqual(timeline.viewAt(2).expression(eaxSource), c32(7));
  deepStrictEqual(timeline.viewAt(0).ref(v(0)), c32(3));
  deepStrictEqual(timeline.viewAt(2).ref(v(1)), c32(7));
  deepStrictEqual(timeline.viewAt(0).storageRead({ source: reg("eax"), accessWidth: 32 }), c32(3));
  deepStrictEqual(timeline.viewAt(2).storageRead({ source: reg("eax"), accessWidth: 32 }), c32(7));
  deepStrictEqual(timeline.writes, [{
    opIndex: 1,
    slot: { kind: "reg32", reg: "eax" },
    value: c32(7)
  }]);
  deepStrictEqual(timeline.finalState.regs.readReg32("eax"), c32(7));
});

test("JIT value timeline records partial register writes as named register aliases", () => {
  const expressionBlock = [
    { op: "set", target: reg("eax"), value: c32(0x7f), accessWidth: 8 }
  ] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    expressions: expressionBlock,
    snapshotPoints: new Set()
  });
  const expected = jitInsertBits(jitInputReg32Value("eax"), c32(0x7f), 0, 8);

  deepStrictEqual(timeline.writes, [{
    opIndex: 0,
    slot: { kind: "reg8", reg: "al" },
    value: c32(0x7f)
  }]);
  deepStrictEqual(timeline.finalState.regs.readReg32("eax"), expected);
});

test("JIT value timeline snapshots are queried at requested points", () => {
  const entry = createJitValueState();
  const expressionBlock = [
    { op: "let32", dst: v(0), value: source(reg("eax")) },
    { op: "set", target: reg("eax"), value: c32(7), accessWidth: 32 },
    { op: "next" }
  ] as const satisfies IrExprBlock;

  entry.regs.writeReg32("eax", c32(3));

  const timeline = buildTimeline({
    expressions: expressionBlock,
    entry: entry.snapshot(),
    snapshotPoints: new Set([0, 2])
  });

  strictEqual(Object.hasOwn(timeline, "snapshots"), false);
  deepStrictEqual(timeline.snapshotAt(0).regs.readReg32("eax"), c32(3));
  deepStrictEqual(timeline.snapshotAt(2).regs.readReg32("eax"), c32(7));
  deepStrictEqual(timeline.finalState.regs.readReg32("eax"), c32(7));
  throws(() => timeline.snapshotAt(1), /missing requested JIT timeline snapshot point/);
  throws(() => timeline.snapshotAt(expressionBlock.length), /missing requested JIT timeline snapshot point/);
});

test("JIT value timeline does not expose unrequested entry or final snapshots", () => {
  const entry = createJitValueState();
  const expressionBlock = [
    { op: "set", target: reg("eax"), value: c32(7), accessWidth: 32 },
    { op: "next" }
  ] as const satisfies IrExprBlock;

  entry.regs.writeReg32("eax", c32(3));

  const timeline = buildTimeline({
    expressions: expressionBlock,
    entry: entry.snapshot(),
    snapshotPoints: new Set()
  });

  deepStrictEqual(timeline.finalState.regs.readReg32("eax"), c32(7));
  throws(() => timeline.snapshotAt(0), /missing requested JIT timeline snapshot point/);
  throws(() => timeline.snapshotAt(expressionBlock.length), /missing requested JIT timeline snapshot point/);
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
    expressions: expressionBlock,
    snapshotPoints: new Set()
  });

  deepStrictEqual(timeline.viewAt(0).expression(condition), jitFlagConditionValue(jitInputAluFlagsValue(), "E"));
  deepStrictEqual(timeline.viewAt(4).expression(condition), jitFlagConditionValue(expectedFlags, "E"));
  deepStrictEqual(timeline.writes, [{
    opIndex: 3,
    slot: { kind: "aluFlags" },
    value: expectedFlags
  }]);
});

test("JIT value timeline records memory operand effective addresses", () => {
  const entry = createJitValueState();
  const address = exprAdd(
    exprAdd(source(reg("eax")), exprShl(source(reg("ecx")), c32(2))),
    c32(0x20)
  );
  const memory = { kind: "mem", address } as const satisfies IrStorageExpr;
  const expressionBlock = [
    { op: "let32", dst: v(0), value: address },
    { op: "set", target: memory, value: c32(7), accessWidth: 32 }
  ] as const satisfies IrExprBlock;

  entry.regs.writeReg32("eax", c32(3));
  entry.regs.writeReg32("ecx", c32(5));

  const timeline = buildTimeline({
    expressions: expressionBlock,
    entry: entry.snapshot(),
    snapshotPoints: new Set()
  });
  const expectedAddress = jitAdd(jitAdd(c32(3), c32(20)), c32(0x20));

  deepStrictEqual(timeline.viewAt(0).expression(address), expectedAddress);
  deepStrictEqual(timeline.viewAt(1).storageAddress(memory), expectedAddress);
  throws(() => timeline.viewAt(0).storageRead({ source: memory, accessWidth: 32 }));
  throws(() => timeline.viewAt(1).storageRead({ source: memory, accessWidth: 32 }));
});

test("JIT source-state values and value timeline resolve overlapping values the same way", () => {
  const eax = c32(0x1234_5678);
  const ecx = c32(5);
  const flags = c32(0x40);
  const registerValues = new Map<Reg32, JitValue>([
    ["eax", eax],
    ["ecx", ecx]
  ]);
  const ah = { kind: "reg", reg: "ah" } as const satisfies IrStorageExpr;
  const address = exprAdd(
    exprAdd(source(reg("eax")), exprShl(source(reg("ecx")), c32(2))),
    c32(0x20)
  );
  const entry = createJitValueState();
  entry.regs.writeReg32("eax", eax);
  entry.regs.writeReg32("ecx", ecx);
  entry.flags.writeAluFlags(flags);

  const condition = { kind: "flags.condition", cc: "E" } as const satisfies IrValueExpr;
  const expressionBlock = [
    { op: "let32", dst: v(0), value: source(ah, 8) },
    { op: "let32", dst: v(1), value: address },
    { op: "let32", dst: v(2), value: condition }
  ] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    expressions: expressionBlock,
    entry: entry.snapshot(),
    snapshotPoints: new Set()
  });
  const resolver = createJitValueResolver({
    readReg32: (reg) => registerValues.get(reg) ?? jitInputReg32Value(reg),
    readAluFlags: () => flags
  });

  deepStrictEqual(resolver.valueForExpression(expressionBlock[0].value), timeline.viewAt(0).ref(v(0)));
  deepStrictEqual(resolver.valueForExpression(expressionBlock[1].value), timeline.viewAt(1).ref(v(1)));
  deepStrictEqual(resolver.valueForExpression(expressionBlock[2].value), timeline.viewAt(2).ref(v(2)));
});

test("JIT timeline op view reads planned effective-address lookups only", () => {
  const memory = { kind: "mem", address: exprAdd(source(reg("eax")), c32(4)) } as const satisfies IrStorageExpr;
  const expressionBlock = [
    { op: "let32", dst: v(0), value: c32(1) },
    { op: "set", target: memory, value: c32(2), accessWidth: 32 }
  ] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    expressions: expressionBlock,
    snapshotPoints: new Set()
  });

  throws(() => timeline.viewAt(0).storageAddress(memory));
  deepStrictEqual(
    timeline.viewAt(1).storageAddress(memory),
    timeline.viewAt(1).value(memory.address)
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
    expressions: expressionBlock,
    entry: entry.snapshot(),
    snapshotPoints: new Set()
  });

  throws(() => timeline.viewAt(0).storageRead({ source: reg("eax"), accessWidth: 32 }));
  deepStrictEqual(timeline.viewAt(1).storageRead({ source: reg("eax"), accessWidth: 32 }), c32(3));
});

test("JIT timeline records memory-load values at one point", () => {
  const loadResult = jitLoadResultValue(0, "i32");
  const expressionBlock = [
    { op: "let32", dst: v(0), value: source({ kind: "mem", address: c32(0x1000) }, 32) },
    { op: "let32", dst: v(1), value: v(0) }
  ] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    expressions: expressionBlock,
    snapshotPoints: new Set()
  });

  deepStrictEqual(timeline.memoryLoadValues, [{
    opIndex: 0,
    ref: v(0),
    value: loadResult
  }]);
  deepStrictEqual(timeline.viewAt(0).ref(v(0)), loadResult);
  deepStrictEqual(timeline.viewAt(1).ref(v(1)), loadResult);
  deepStrictEqual(timeline.viewAt(0).expression(expressionBlock[0].value), loadResult);
  deepStrictEqual(timeline.viewAt(0).storageRead({
    source: expressionBlock[0].value.source,
    accessWidth: expressionBlock[0].value.accessWidth
  }), loadResult);
});

test("JIT timeline records memory-load values for memory operand reads only", () => {
  const loadResult = jitLoadResultValue(0, "i32");
  const memory = { kind: "mem", address: source(reg("ebx"), 32) } as const satisfies IrStorageExpr;
  const expressionBlock = [
    { op: "let32", dst: v(0), value: source(memory, 32) },
    { op: "let32", dst: v(1), value: source(reg("eax"), 32) }
  ] as const satisfies IrExprBlock;
  const timeline = buildTimeline({
    expressions: expressionBlock,
    snapshotPoints: new Set()
  });

  deepStrictEqual(timeline.memoryLoadValues, [{
    opIndex: 0,
    ref: v(0),
    value: loadResult
  }]);
  deepStrictEqual(timeline.viewAt(0).ref(v(0)), loadResult);
  deepStrictEqual(timeline.viewAt(1).ref(v(1)), jitInputReg32Value("eax"));
});

test("JIT block analysis allocates distinct load-result IDs across memory loads", () => {
  const block = {
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "mem", address: c32(0x1000) }, accessWidth: 32 },
        { op: "next" }
      ], 0),
      syntheticInstruction([
        { op: "get", dst: v(1), source: { kind: "mem", address: c32(0x1004) }, accessWidth: 32 },
        { op: "next" }
      ], 1)
    ]
  };
  const analysis = analyzeBlock(buildBlockExpressions(block));
  const firstLoadResult = analysis.timeline.memoryLoadValues[0]?.value;
  const secondLoadResult = analysis.timeline.memoryLoadValues[1]?.value;

  deepStrictEqual(firstLoadResult, jitLoadResultValue(0, "i32"));
  deepStrictEqual(secondLoadResult, jitLoadResultValue(1, "i32"));
  strictEqual(firstLoadResult?.id === secondLoadResult?.id, false);
});

test("JIT timeline op view fails clearly for invalid op indexes", () => {
  const timeline = buildTimeline({
    expressions: [{ op: "let32", dst: v(0), value: c32(1) }],
    snapshotPoints: new Set()
  });

  throws(() => timeline.viewAt(1));
});

test("JIT value timeline fails clearly for unresolved values", () => {
  throws(
    () => buildTimeline({
      expressions: [{ op: "hostTrap", vector: v(99) }],
      snapshotPoints: new Set()
    }),
    /could not resolve JIT timeline value at expression op 0/
  );
});

test("JIT value timeline ignores no-op flag writes before resolving inputs", () => {
  const timeline = buildTimeline({
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
    snapshotPoints: new Set()
  });

  deepStrictEqual(timeline.writes, []);
  throws(() => timeline.viewAt(0).ref(v(100)));
  throws(() => timeline.viewAt(0).ref(v(101)));
  throws(() => timeline.viewAt(0).ref(v(102)));
});

function v(id: number) {
  return { kind: "var" as const, id };
}

function reg(name: Reg32) {
  return { kind: "reg" as const, reg: name };
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

function exprShl(a: IrValueExpr, b: IrValueExpr): Extract<IrValueExpr, { kind: "value.binary" }> {
  return { kind: "value.binary", type: "i32", operator: "shl", a, b };
}
