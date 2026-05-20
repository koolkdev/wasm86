import {
  deepStrictEqual,
  test,
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS,
  FLAG_PRODUCERS,
  jitExtractMaskedBits,
  jitFlagConditionValue,
  jitFlagProducerValue,
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
  const incFlags = jitFlagProducerValue("inc", {
    left: eax,
    result
  }, { mask: FLAG_PRODUCERS.inc.writtenMask });

  state.flags.writeFlagBits(FLAG_PRODUCERS.inc.writtenMask, incFlags);

  const expected = jitInsertMaskedBits(
    jitInputAluFlagsValue(),
    incFlags,
    FLAG_PRODUCERS.inc.writtenMask
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
  const incFlags = jitFlagProducerValue("inc", {
    left: eax,
    result: incResult
  }, { mask: FLAG_PRODUCERS.inc.writtenMask });
  const addFlags = jitFlagProducerValue("add", {
    left: eax,
    right: jitInputReg32Value("ebx"),
    result: addResult
  }, { mask: IR_ALU_FLAG_MASK });

  state.flags.writeFlagBits(FLAG_PRODUCERS.inc.writtenMask, incFlags);
  state.flags.writeFlagBits(IR_ALU_FLAG_MASK, addFlags);

  const snapshot = state.snapshot();

  deepStrictEqual(snapshot.flags.readAluFlags(), addFlags);
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["aluFlags"]);
  deepStrictEqual(snapshot.slots.changedEntries()[0]?.value, addFlags);
});
