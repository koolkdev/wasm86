import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS
} from "#x86/ir/model/flag-effects.js";
import {
  jitExtractBits,
  jitExtractMaskedBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitInputAluFlagsValue,
  jitInputReg16Value,
  jitInputReg32Value,
  jitInputReg8Value,
  jitInsertBits,
  jitInsertMaskedBits,
  jitLoadResultValue
} from "#backends/wasm/jit/ir/values/builders.js";
import {
  jitArchitecturalSlotKey,
  jitArchitecturalSlotsOverlap,
  slotsReadByValue,
  slotsReadByValueForMask
} from "#backends/wasm/jit/ir/values/slots.js";
import { valueCost } from "#backends/wasm/jit/ir/values/cost.js";
import { valueKey } from "#backends/wasm/jit/ir/values/keys.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import {
  valueChildren,
  walkValueChildren
} from "#backends/wasm/jit/ir/values/walk.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";

test("JitValue bit constructors are raw and explicit simplification preserves semantics", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const constExtract = jitExtractBits(c32(0x1234_5678), 8, 8);
  const identityInsert = jitInsertBits(eax, jitExtractBits(eax, 0, 8), 0, 8);
  const insertedExtract = jitExtractBits(jitInsertBits(eax, ebx, 0, 8), 0, 8);
  const repeatedInsert = jitInsertBits(jitInsertBits(eax, c32(0x12), 0, 8), c32(0x34), 0, 8);

  deepStrictEqual(constExtract, { kind: "extractBits", value: c32(0x1234_5678), bitOffset: 8, width: 8 });
  deepStrictEqual(identityInsert, {
    kind: "insertBits",
    base: eax,
    value: jitExtractBits(eax, 0, 8),
    bitOffset: 0,
    width: 8
  });
  deepStrictEqual(simplifyValue(constExtract), c32(0x56));
  deepStrictEqual(simplifyValue(identityInsert), eax);
  deepStrictEqual(
    simplifyValue(insertedExtract),
    jitExtractBits(ebx, 0, 8)
  );
  deepStrictEqual(
    simplifyValue(repeatedInsert),
    jitInsertBits(eax, c32(0x34), 0, 8)
  );
});

test("JitValue masked-bit constructors are raw and explicit simplification models preservation", () => {
  const flags = jitInputAluFlagsValue();
  const cfMask = IR_ALU_FLAG_MASKS.CF;
  const identityInsert = jitInsertMaskedBits(flags, jitExtractMaskedBits(flags, cfMask), cfMask);
  const preservedCf = jitExtractMaskedBits(jitInsertMaskedBits(flags, c32(0), IR_ALU_FLAG_MASKS.ZF), cfMask);

  deepStrictEqual(identityInsert, {
    kind: "insertMaskedBits",
    base: flags,
    value: jitExtractMaskedBits(flags, cfMask),
    mask: cfMask
  });
  deepStrictEqual(
    simplifyValue(identityInsert),
    flags
  );
  deepStrictEqual(
    simplifyValue(preservedCf),
    jitExtractMaskedBits(flags, cfMask)
  );
});

test("JitValue flagProducer derives metadata and validates masks", () => {
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

  strictEqual(valuesEqual(first, second), true);
  strictEqual(valueKey(first), valueKey(second));
  strictEqual(valuesEqual(left, right), true);
  strictEqual(valueKey(left), valueKey(right));
});

test("JitValue architectural slots distinguish aliases exactly and detect overlap", () => {
  const eax = { kind: "reg32", reg: "eax" } as const;
  const ax = { kind: "reg16", reg: "ax" } as const;
  const al = { kind: "reg8", reg: "al" } as const;
  const ah = { kind: "reg8", reg: "ah" } as const;
  const bl = { kind: "reg8", reg: "bl" } as const;
  const canonicalAl = jitExtractBits(jitInputReg32Value("eax"), 0, 8);

  strictEqual(valueKey(jitInputReg32Value("eax")), "input:reg32:eax");
  strictEqual(valueKey(jitInputReg16Value("ax")), "extractBits:0:16:input:reg32:eax");
  strictEqual(valueKey(jitInputReg8Value("al")), "extractBits:0:8:input:reg32:eax");
  strictEqual(valuesEqual(jitInputReg32Value("eax"), jitInputReg8Value("al")), false);
  strictEqual(valuesEqual(jitInputReg8Value("al"), canonicalAl), true);
  deepStrictEqual(
    simplifyValue(jitInsertBits(jitInputReg32Value("eax"), jitInputReg8Value("al"), 0, 8)),
    jitInputReg32Value("eax")
  );
  strictEqual(jitArchitecturalSlotsOverlap(eax, ax), true);
  strictEqual(jitArchitecturalSlotsOverlap(ax, al), true);
  strictEqual(jitArchitecturalSlotsOverlap(al, ah), false);
  strictEqual(jitArchitecturalSlotsOverlap(al, bl), false);
});

test("JitValue helper contract covers every value kind", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const flags = jitInputAluFlagsValue();
  const binary = add(eax, c32(5));
  const flagProducer = jitFlagProducerValue("add", {
    left: eax,
    right: ebx,
    result: add(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASKS.CF | IR_ALU_FLAG_MASKS.ZF });
  const cases: readonly ValueContractCase[] = [
    {
      kind: "const",
      value: c32(3),
      same: c32(3),
      different: c32(4),
      children: [],
      slots: []
    },
    {
      kind: "input",
      value: eax,
      same: jitInputReg32Value("eax"),
      different: ebx,
      children: [],
      slots: ["reg32:eax"]
    },
    {
      kind: "loadResult",
      value: jitLoadResultValue(0, "i32"),
      same: jitLoadResultValue(0, "i32"),
      different: jitLoadResultValue(1, "i32"),
      children: [],
      slots: []
    },
    {
      kind: "value.binary",
      value: binary,
      same: add(jitInputReg32Value("eax"), c32(5)),
      different: add(eax, c32(6)),
      children: [eax, c32(5)],
      slots: ["reg32:eax"]
    },
    {
      kind: "value.unary",
      value: extend8s(eax),
      same: extend8s(jitInputReg32Value("eax")),
      different: extend16s(eax),
      children: [eax],
      slots: ["reg32:eax"]
    },
    {
      kind: "value.select",
      value: select(eax, ebx, c32(7)),
      same: select(jitInputReg32Value("eax"), jitInputReg32Value("ebx"), c32(7)),
      different: select(eax, ebx, c32(8)),
      children: [eax, ebx, c32(7)],
      slots: ["reg32:eax", "reg32:ebx"]
    },
    {
      kind: "extractBits",
      value: jitExtractBits(eax, 8, 8),
      same: jitExtractBits(jitInputReg32Value("eax"), 8, 8),
      different: jitExtractBits(eax, 16, 8),
      children: [eax],
      slots: ["reg32:eax"]
    },
    {
      kind: "insertBits",
      value: jitInsertBits(eax, ebx, 8, 8),
      same: jitInsertBits(jitInputReg32Value("eax"), jitInputReg32Value("ebx"), 8, 8),
      different: jitInsertBits(eax, ebx, 16, 8),
      children: [eax, ebx],
      slots: ["reg32:eax", "reg32:ebx"]
    },
    {
      kind: "extractMaskedBits",
      value: jitExtractMaskedBits(eax, 0xff00),
      same: jitExtractMaskedBits(jitInputReg32Value("eax"), 0xff00),
      different: jitExtractMaskedBits(eax, 0xff),
      children: [eax],
      slots: ["reg32:eax"]
    },
    {
      kind: "insertMaskedBits",
      value: jitInsertMaskedBits(eax, ebx, 0xff00),
      same: jitInsertMaskedBits(jitInputReg32Value("eax"), jitInputReg32Value("ebx"), 0xff00),
      different: jitInsertMaskedBits(eax, ebx, 0xff),
      children: [eax, ebx],
      slots: ["reg32:eax", "reg32:ebx"]
    },
    {
      kind: "flagProducer",
      value: flagProducer,
      same: jitFlagProducerValue("add", {
        left: jitInputReg32Value("eax"),
        right: jitInputReg32Value("ebx"),
        result: add(jitInputReg32Value("eax"), jitInputReg32Value("ebx"))
      }, { mask: IR_ALU_FLAG_MASKS.CF | IR_ALU_FLAG_MASKS.ZF }),
      different: jitFlagProducerValue("add", {
        left: eax,
        right: ebx,
        result: add(eax, ebx)
      }, { mask: IR_ALU_FLAG_MASKS.ZF }),
      children: [eax, ebx, add(eax, ebx)],
      slots: ["reg32:eax", "reg32:ebx"]
    },
    {
      kind: "flagCondition",
      value: jitFlagConditionValue(flags, "E"),
      same: jitFlagConditionValue(jitInputAluFlagsValue(), "E"),
      different: jitFlagConditionValue(flags, "NE"),
      children: [flags],
      slots: ["aluFlags"]
    }
  ];

  for (const valueCase of cases) {
    strictEqual(valueCase.value.kind, valueCase.kind);
    strictEqual(valuesEqual(valueCase.value, valueCase.same), true, valueCase.kind);
    strictEqual(valuesEqual(valueCase.value, valueCase.different), false, valueCase.kind);
    strictEqual(valueKey(valueCase.value), valueKey(valueCase.same), valueCase.kind);
    strictEqual(valueKey(valueCase.value) === valueKey(valueCase.different), false, valueCase.kind);
    assertValueListEqual(valueChildren(valueCase.value), valueCase.children, valueCase.kind);
    deepStrictEqual(slotKeys(slotsReadByValue(valueCase.value)), valueCase.slots);
    strictEqual(valueCost(valueCase.value), valueCost(valueCase.same), valueCase.kind);
    strictEqual(valueCost(valueCase.value) >= 1, true, valueCase.kind);
  }
});

test("JitValue equality compares simplified structure", () => {
  const eax = jitInputReg32Value("eax");
  const rawIdentity = {
    kind: "insertBits",
    base: eax,
    value: jitExtractBits(eax, 0, 8),
    bitOffset: 0,
    width: 8
  } as const satisfies JitValue;

  strictEqual(valuesEqual(rawIdentity, eax), true);
});

test("JitValue load-result nodes are opaque point-bound results", () => {
  const first = jitLoadResultValue(0, "i32");
  const same = jitLoadResultValue(0, "i32");
  const other = jitLoadResultValue(1, "i32");
  const walked: JitValue[] = [];

  walkValueChildren(first, (dependency) => walked.push(dependency));

  strictEqual(valuesEqual(first, same), true);
  strictEqual(valuesEqual(first, other), false);
  strictEqual(valueKey(first), valueKey(same));
  deepStrictEqual(valueChildren(first), []);
  deepStrictEqual(walked, []);
  deepStrictEqual(slotsReadByValue(first), []);
  strictEqual(valueCost(first), 1);
});

test("JitValue dependency and slot walking includes nested flag inputs", () => {
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

  walkValueChildren(mergedFlags, (dependency) => walked.push(dependency));

  strictEqual(valueChildren(producer).some((value) => valuesEqual(value, lea)), true);
  strictEqual(walked.some((value) => value.kind === "flagProducer"), true);
  deepStrictEqual(slotKeys(slotsReadByValue(mergedFlags)), [
    "aluFlags",
    "reg32:ebx",
    "reg32:ecx",
    "reg32:edx"
  ]);
  strictEqual(valueCost(producer) > valueCost(lea), true);
});

test("JitValue masked slot walking follows required bits", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const insertedLowWord = jitInsertBits(eax, ebx, 0, 16);
  const insertedByteAt8 = jitInsertBits(eax, ebx, 8, 8);
  const signExtendedLowByte = extend8s(jitInsertBits(eax, ebx, 0, 8));

  deepStrictEqual(slotKeys(slotsReadByValueForMask(jitInputReg32Value("eax"), 0xff)), [
    "reg8:al"
  ]);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(jitInputReg32Value("eax"), 0xff00)), [
    "reg8:ah"
  ]);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(jitInputReg32Value("eax"), 0xffff)), [
    "reg16:ax"
  ]);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(insertedLowWord, 0xffff)), [
    "reg16:bx"
  ]);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(insertedLowWord, 0xffff_0000)), [
    "reg32:eax"
  ]);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(insertedLowWord, 0xffff_ffff)), [
    "reg16:bx",
    "reg32:eax"
  ]);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(jitInputReg32Value("eax"), 0xffff_0000)), [
    "reg32:eax"
  ]);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(jitExtractBits(insertedByteAt8, 8, 8), 0xff)), [
    "reg8:bl"
  ]);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(signExtendedLowByte, 0xffff_0000)), [
    "reg8:bl"
  ]);
});

test("JitValue masked slot walking ignores disjoint projected bits", () => {
  const lowByte = jitExtractMaskedBits(jitInputReg32Value("eax"), 0xff);

  deepStrictEqual(simplifyValue(jitExtractMaskedBits(lowByte, 0xff00)), c32(0));
  deepStrictEqual(slotKeys(slotsReadByValueForMask(lowByte, 0xff00)), []);
  deepStrictEqual(slotKeys(slotsReadByValueForMask(lowByte, 0xff)), [
    "reg8:al"
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

function select(condition: JitValue, whenTrue: JitValue, whenFalse: JitValue): JitValue {
  return { kind: "value.select", type: "i32", condition, whenTrue, whenFalse };
}

function extend8s(value: JitValue): JitValue {
  return { kind: "value.unary", type: "i32", operator: "extend8_s", value };
}

function extend16s(value: JitValue): JitValue {
  return { kind: "value.unary", type: "i32", operator: "extend16_s", value };
}

function slotKeys(slots: readonly JitArchitecturalSlot[]): readonly string[] {
  return slots.map(jitArchitecturalSlotKey).sort();
}

type ValueContractCase = Readonly<{
  kind: JitValue["kind"];
  value: JitValue;
  same: JitValue;
  different: JitValue;
  children: readonly JitValue[];
  slots: readonly string[];
}>;

function assertValueListEqual(
  actual: readonly JitValue[],
  expected: readonly JitValue[],
  context: string
): void {
  strictEqual(actual.length, expected.length, context);

  for (let index = 0; index < actual.length; index += 1) {
    strictEqual(valuesEqual(actual[index]!, expected[index]!), true, `${context} child ${index}`);
  }
}
