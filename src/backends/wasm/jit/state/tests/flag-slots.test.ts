import {
  deepStrictEqual,
  test,
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS,
  jitExtractMaskedBits,
  jitFlagConditionValue,
  jitFlagWriteValue,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertMaskedBits,
  simplifyValue,
  createJitValueState,
  c32,
  add,
  changedSlots,
} from "./value-state-test-helpers.js";
test("JIT ALU flag value family preserves partial flag writes symbolically", () => {
  const state = createJitValueState();
  const eax = jitInputReg32Value("eax");
  const result = add(eax, c32(1));
  const partialMask = IR_ALU_FLAG_MASK & ~IR_ALU_FLAG_MASKS.CF;
  const incFlags = jitFlagWriteValue({
    PF: { kind: "expr", value: result },
    AF: { kind: "expr", value: result },
    ZF: { kind: "expr", value: result },
    SF: { kind: "expr", value: result },
    OF: { kind: "expr", value: result }
  });

  state.flags.writeFlagBits(partialMask, incFlags);

  const expected = jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    incFlags,
    partialMask
  );

  deepStrictEqual(state.flags.readAluFlags(), expected);
  deepStrictEqual(state.flags.readFlagBits(IR_ALU_FLAG_MASKS.CF), jitExtractMaskedBits(
    expected,
    IR_ALU_FLAG_MASKS.CF
  ));
  deepStrictEqual(state.flags.readFlagBits(IR_ALU_FLAG_MASKS.ZF), jitExtractMaskedBits(
    expected,
    IR_ALU_FLAG_MASKS.ZF
  ));
  deepStrictEqual(simplifyValue(state.flags.readFlagBits(IR_ALU_FLAG_MASKS.CF)), jitExtractMaskedBits(
    jitInputAluFlagsValue(),
    IR_ALU_FLAG_MASKS.CF
  ));
  deepStrictEqual(simplifyValue(state.flags.readFlagBits(IR_ALU_FLAG_MASKS.ZF)), jitExtractMaskedBits(
    incFlags,
    IR_ALU_FLAG_MASKS.ZF
  ));
  deepStrictEqual(state.flags.condition("E"), jitFlagConditionValue(expected, "E"));
  deepStrictEqual(changedSlots(state.snapshot().slots.changedEntries()), ["aluFlags"]);
});

test("JIT ALU flag value family tracks exact projected partial writes conservatively", () => {
  const state = createJitValueState();

  state.flags.writeFlagBits(IR_ALU_FLAG_MASKS.CF, state.flags.readFlagBits(IR_ALU_FLAG_MASKS.CF));

  deepStrictEqual(changedSlots(state.snapshot().slots.changedEntries()), ["aluFlags"]);
  deepStrictEqual(simplifyValue(state.flags.readAluFlags()), jitInputAluFlagsValue());
});

test("JIT ALU flag value family lets later full writes replace partial merges", () => {
  const state = createJitValueState();
  const eax = jitInputReg32Value("eax");
  const incResult = add(eax, c32(1));
  const addResult = add(eax, jitInputReg32Value("ebx"));
  const partialMask = IR_ALU_FLAG_MASK & ~IR_ALU_FLAG_MASKS.CF;
  const incFlags = jitFlagWriteValue({
    PF: { kind: "expr", value: incResult },
    AF: { kind: "expr", value: incResult },
    ZF: { kind: "expr", value: incResult },
    SF: { kind: "expr", value: incResult },
    OF: { kind: "expr", value: incResult }
  });
  const addFlags = jitFlagWriteValue({
    CF: { kind: "expr", value: addResult },
    PF: { kind: "expr", value: addResult },
    AF: { kind: "expr", value: addResult },
    ZF: { kind: "expr", value: addResult },
    SF: { kind: "expr", value: addResult },
    OF: { kind: "expr", value: addResult }
  });

  state.flags.writeFlagBits(partialMask, incFlags);
  state.flags.writeFlagBits(IR_ALU_FLAG_MASK, addFlags);

  const snapshot = state.snapshot();

  deepStrictEqual(snapshot.flags.readAluFlags(), addFlags);
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["aluFlags"]);
  deepStrictEqual(snapshot.slots.changedEntries()[0]?.value, addFlags);
});
