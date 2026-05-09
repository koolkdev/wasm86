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
  jitValueCost,
  jitValueDependencies,
  jitValueKey,
  jitValueMaterializationSlots,
  jitValuesEqual,
  walkJitValueDependencies,
  type JitArchitecturalSlot,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";

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

function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

function add(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

function sub(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "sub", a, b };
}

function slotKeys(slots: readonly JitArchitecturalSlot[]): readonly string[] {
  return slots.map((slot) => slot.kind === "aluFlags" ? "aluFlags" : `reg32:${slot.reg}`).sort();
}
