import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS
} from "#x86/ir/model/flag-effects.js";
import {
  jitExtractBits,
  jitExtractMaskedBits,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits,
  jitProducedValue
} from "#backends/wasm/jit/ir/value-builders.js";
import {
  jitValueCost,
  jitValueDependencies,
  jitValueKey,
  jitValueMaterializationSlots,
  jitValueMaterializationSlotsForMask,
  walkJitValueDependencies
} from "#backends/wasm/jit/ir/value-analysis.js";
import { jitValuesEqual } from "#backends/wasm/jit/ir/value-equality.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/value-types.js";
import { indexProducedValuesByVarIdForInstruction } from "#backends/wasm/jit/ir/produced-values.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";

test("JitValue bit simplification preserves exact unsigned bit semantics", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");

  deepStrictEqual(jitExtractBits(c32(0x1234_5678), 8, 8), c32(0x56));
  deepStrictEqual(jitInsertBits(eax, jitExtractBits(eax, 0, 8), 0, 8), eax);
  deepStrictEqual(
    jitExtractBits(jitInsertBits(eax, ebx, 0, 8), 0, 8),
    jitExtractBits(ebx, 0, 8)
  );
  deepStrictEqual(
    jitInsertBits(jitInsertBits(eax, c32(0x12), 0, 8), c32(0x34), 0, 8),
    jitInsertBits(eax, c32(0x34), 0, 8)
  );
});

test("JitValue masked-bit simplification models flag preservation", () => {
  const flags = jitInputAluFlagsValue();
  const cfMask = IR_ALU_FLAG_MASKS.CF;

  deepStrictEqual(
    jitInsertMaskedBits(flags, jitExtractMaskedBits(flags, cfMask), cfMask),
    flags
  );
  deepStrictEqual(
    jitExtractMaskedBits(jitInsertMaskedBits(flags, c32(0), IR_ALU_FLAG_MASKS.ZF), cfMask),
    jitExtractMaskedBits(flags, cfMask)
  );
});

test("JitValue flagProducer derives metadata and validates produced masks", () => {
  const eax = jitInputReg32Value("eax");
  const result = add(eax, c32(1));

  throws(
    () => jitFlagProducerValue("inc", { left: eax, result }, { mask: IR_ALU_FLAG_MASKS.CF }),
    /bits not written by inc/
  );

  const flags = jitFlagProducerValue("add", {
    left: eax,
    right: c32(1),
    result
  }, { mask: IR_ALU_FLAG_MASK });

  strictEqual(flags.kind, "flagProducer");
  strictEqual("writtenMask" in flags, false);
  strictEqual("undefMask" in flags, false);
});

test("JitValue equality and cache keys are canonical after simplification", () => {
  const eax = jitInputReg32Value("eax");
  const first = jitInsertBits(eax, jitExtractBits(eax, 0, 8), 0, 8);
  const second = jitInputReg32Value("eax");
  const left = jitFlagProducerValue("sub", {
    left: eax,
    right: c32(1),
    result: sub(eax, c32(1))
  }, { mask: IR_ALU_FLAG_MASKS.ZF });
  const right = jitFlagProducerValue("sub", {
    left: jitInputReg32Value("eax"),
    right: c32(1),
    result: sub(jitInputReg32Value("eax"), c32(1))
  }, { mask: IR_ALU_FLAG_MASKS.ZF });

  strictEqual(jitValuesEqual(first, second), true);
  strictEqual(jitValueKey(first), jitValueKey(second));
  strictEqual(jitValuesEqual(left, right), true);
  strictEqual(jitValueKey(left), jitValueKey(right));
});

test("JitValue produced nodes are opaque point-bound results", () => {
  const first = jitProducedValue("load#0:1:2", "i32");
  const same = jitProducedValue("load#0:1:2", "i32");
  const other = jitProducedValue("load#0:1:3", "i32");
  const walked: JitValue[] = [];

  walkJitValueDependencies(first, (dependency) => walked.push(dependency));

  strictEqual(jitValuesEqual(first, same), true);
  strictEqual(jitValuesEqual(first, other), false);
  strictEqual(jitValueKey(first), jitValueKey(same));
  deepStrictEqual(jitValueDependencies(first), []);
  deepStrictEqual(walked, []);
  deepStrictEqual(jitValueMaterializationSlots(first), []);
  strictEqual(jitValueCost(first), 1);
});

test("JIT produced-value indexing assigns ids to effectful get results only", () => {
  const instruction = {
    instructionId: "mov-r32-rm32",
    eip: 0x1000,
    nextEip: 0x1002,
    nextMode: "exit",
    operands: [{
      kind: "static.mem",
      ea: { kind: "mem", base: "ebx", scale: 1, disp: 0, accessWidth: 32 }
    }],
    ir: [
      { op: "address", dst: { kind: "var", id: 0 }, operand: { kind: "operand", index: 0 } },
      { op: "get", dst: { kind: "var", id: 1 }, source: { kind: "operand", index: 0 }, accessWidth: 32 },
      { op: "get", dst: { kind: "var", id: 2 }, source: { kind: "reg", reg: "eax" }, accessWidth: 32 }
    ]
  } as const satisfies JitIrBlockInstruction;
  const producedValues = indexProducedValuesByVarIdForInstruction(instruction, 3);

  deepStrictEqual([...producedValues.keys()], [1]);
  deepStrictEqual(
    producedValues.get(1),
    jitProducedValue("load#mov-r32-rm32:3:1:1", "i32")
  );
});

test("JitValue dependency and materialization-slot walking includes nested flag inputs", () => {
  const ebx = jitInputReg32Value("ebx");
  const ecx = jitInputReg32Value("ecx");
  const edx = jitInputReg32Value("edx");
  const lea = add(ebx, ecx);
  const result = add(edx, lea);
  const producer = jitFlagProducerValue("add", {
    left: edx,
    right: lea,
    result
  }, { mask: IR_ALU_FLAG_MASK });
  const mergedFlags = jitInsertMaskedBits(jitInputAluFlagsValue(), producer, IR_ALU_FLAG_MASK);
  const walked: JitValue[] = [];

  walkJitValueDependencies(mergedFlags, (dependency) => walked.push(dependency));

  strictEqual(jitValueDependencies(producer).some((value) => jitValuesEqual(value, lea)), true);
  strictEqual(walked.some((value) => value.kind === "flagProducer"), true);
  deepStrictEqual(slotKeys(jitValueMaterializationSlots(mergedFlags)), [
    "aluFlags",
    "reg32:ebx",
    "reg32:ecx",
    "reg32:edx"
  ]);
  strictEqual(jitValueCost(producer) > jitValueCost(lea), true);
});

test("JitValue masked materialization-slot walking follows required bits", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const insertedLowWord = jitInsertBits(eax, ebx, 0, 16);
  const insertedByteAt8 = jitInsertBits(eax, ebx, 8, 8);
  const signExtendedLowByte = extend8s(jitInsertBits(eax, ebx, 0, 8));

  deepStrictEqual(slotKeys(jitValueMaterializationSlotsForMask(insertedLowWord, 0xffff)), [
    "reg32:ebx"
  ]);
  deepStrictEqual(slotKeys(jitValueMaterializationSlotsForMask(insertedLowWord, 0xffff_0000)), [
    "reg32:eax"
  ]);
  deepStrictEqual(slotKeys(jitValueMaterializationSlotsForMask(insertedLowWord, 0xffff_ffff)), [
    "reg32:eax",
    "reg32:ebx"
  ]);
  deepStrictEqual(slotKeys(jitValueMaterializationSlotsForMask(jitExtractBits(insertedByteAt8, 8, 8), 0xff)), [
    "reg32:ebx"
  ]);
  deepStrictEqual(slotKeys(jitValueMaterializationSlotsForMask(signExtendedLowByte, 0xffff_0000)), [
    "reg32:ebx"
  ]);
});

function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

function add(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

function sub(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "sub", a, b };
}

function extend8s(value: JitValue): JitValue {
  return { kind: "value.unary", type: "i32", operator: "extend8_s", value };
}

function slotKeys(slots: readonly JitArchitecturalSlot[]): readonly string[] {
  return slots.map((slot) => slot.kind === "aluFlags" ? "aluFlags" : `reg32:${slot.reg}`).sort();
}
