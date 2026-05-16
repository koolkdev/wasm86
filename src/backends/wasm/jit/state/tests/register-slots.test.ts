import {
  deepStrictEqual,
  strictEqual,
  test,
  IR_ALU_FLAG_MASKS,
  jitExtractBits,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  createJitValueState,
  reg16Slot,
  reg8Slot,
  xchg,
  c32,
  changedSlots,
} from "./value-state-test-helpers.js";
test("JIT value state omits unchanged input register and flag slots", () => {
  const state = createJitValueState();

  deepStrictEqual(state.regs.readReg32("eax"), jitInputReg32Value("eax"));
  deepStrictEqual(state.flags.readAluFlags(), jitInputAluFlagsValue());

  state.regs.writeReg32("eax", jitInputReg32Value("eax"));
  state.flags.writeAluFlags(jitInputAluFlagsValue());

  const snapshot = state.snapshot();

  strictEqual(snapshot.regs.differsFromInput("eax"), false);
  strictEqual(snapshot.flags.differsFromInput(), false);
  deepStrictEqual(snapshot.slots.changedEntries(), []);
});

test("JIT register value family models prefixes as bit extraction and insertion", () => {
  const state = createJitValueState();
  const inputEax = jitInputReg32Value("eax");

  deepStrictEqual(state.regs.readReg8("al"), jitExtractBits(inputEax, 0, 8));
  deepStrictEqual(state.regs.readReg8("ah"), jitExtractBits(inputEax, 8, 8));
  deepStrictEqual(state.regs.readReg16("ax"), jitExtractBits(inputEax, 0, 16));

  state.regs.writeReg8("al", c32(0x7f));

  const snapshot = state.snapshot();
  const expected = jitInsertBits(inputEax, c32(0x7f), 0, 8);

  deepStrictEqual(snapshot.regs.readReg32("eax"), expected);
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:eax"]);
  deepStrictEqual(snapshot.slots.changedEntries()[0]?.value, expected);
});

test("JIT value slots canonicalize IR register aliases through the 32-bit base", () => {
  const state = createJitValueState();

  deepStrictEqual(state.slots.read(reg8Slot("al")), jitExtractBits(jitInputReg32Value("eax"), 0, 8));
  deepStrictEqual(state.slots.read(reg16Slot("ax")), jitExtractBits(jitInputReg32Value("eax"), 0, 16));

  state.slots.write(reg8Slot("ah"), c32(0x12));

  const snapshot = state.snapshot();
  const expected = jitInsertBits(jitInputReg32Value("eax"), c32(0x12), 8, 8);

  deepStrictEqual(snapshot.regs.readReg32("eax"), expected);
  deepStrictEqual(snapshot.slots.read(reg8Slot("ah")), c32(0x12));
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:eax"]);
});

test("JIT register value family simplifies prefix identity writes away", () => {
  const state = createJitValueState();

  state.regs.writeReg8("al", state.regs.readReg8("al"));
  state.regs.writeReg8("bh", state.regs.readReg8("bh"));
  state.regs.writeReg16("cx", state.regs.readReg16("cx"));

  const snapshot = state.snapshot();

  deepStrictEqual(snapshot.regs.readReg32("eax"), jitInputReg32Value("eax"));
  deepStrictEqual(snapshot.regs.readReg32("ebx"), jitInputReg32Value("ebx"));
  deepStrictEqual(snapshot.regs.readReg32("ecx"), jitInputReg32Value("ecx"));
  deepStrictEqual(snapshot.slots.changedEntries(), []);
});

test("JIT register value family lets later full writes replace prefix merges", () => {
  const state = createJitValueState();

  state.regs.writeReg8("al", c32(0x7f));
  state.regs.writeReg32("eax", jitInputReg32Value("ebx"));

  const snapshot = state.snapshot();

  deepStrictEqual(snapshot.regs.readReg32("eax"), jitInputReg32Value("ebx"));
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:eax"]);
  deepStrictEqual(snapshot.slots.changedEntries()[0]?.value, jitInputReg32Value("ebx"));
});

test("JIT register value family recognizes repeated xchg cancellation", () => {
  const state = createJitValueState();

  xchg(state, "eax", "ebx");
  xchg(state, "eax", "ebx");

  const snapshot = state.snapshot();

  deepStrictEqual(snapshot.regs.readReg32("eax"), jitInputReg32Value("eax"));
  deepStrictEqual(snapshot.regs.readReg32("ebx"), jitInputReg32Value("ebx"));
  deepStrictEqual(snapshot.slots.changedEntries(), []);
});

test("JIT register value family preserves remaining xchg permutations symbolically", () => {
  const state = createJitValueState();

  xchg(state, "eax", "ebx");
  xchg(state, "ecx", "edx");
  xchg(state, "eax", "ebx");

  const snapshot = state.snapshot();

  deepStrictEqual(snapshot.regs.readReg32("eax"), jitInputReg32Value("eax"));
  deepStrictEqual(snapshot.regs.readReg32("ebx"), jitInputReg32Value("ebx"));
  deepStrictEqual(snapshot.regs.readReg32("ecx"), jitInputReg32Value("edx"));
  deepStrictEqual(snapshot.regs.readReg32("edx"), jitInputReg32Value("ecx"));
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:ecx", "reg32:edx"]);
});

test("JIT register value family preserves xchg rotations as input sources", () => {
  const state = createJitValueState();

  xchg(state, "eax", "ebx");
  xchg(state, "ebx", "ecx");

  const snapshot = state.snapshot();

  deepStrictEqual(snapshot.regs.readReg32("eax"), jitInputReg32Value("ebx"));
  deepStrictEqual(snapshot.regs.readReg32("ebx"), jitInputReg32Value("ecx"));
  deepStrictEqual(snapshot.regs.readReg32("ecx"), jitInputReg32Value("eax"));
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:eax", "reg32:ebx", "reg32:ecx"]);
});

test("JIT value state snapshots are immutable views of earlier slot values", () => {
  const state = createJitValueState();

  state.regs.writeReg32("eax", c32(1));
  const first = state.snapshot();

  state.regs.writeReg32("ebx", c32(2));
  state.flags.writeAluFlags(c32(IR_ALU_FLAG_MASKS.ZF));
  const second = state.snapshot();

  deepStrictEqual(first.regs.readReg32("eax"), c32(1));
  deepStrictEqual(first.regs.readReg32("ebx"), jitInputReg32Value("ebx"));
  deepStrictEqual(first.flags.readAluFlags(), jitInputAluFlagsValue());
  deepStrictEqual(changedSlots(first.slots.changedEntries()), ["reg32:eax"]);

  deepStrictEqual(second.regs.readReg32("eax"), c32(1));
  deepStrictEqual(second.regs.readReg32("ebx"), c32(2));
  deepStrictEqual(second.flags.readAluFlags(), c32(IR_ALU_FLAG_MASKS.ZF));
  deepStrictEqual(changedSlots(second.slots.changedEntries()), ["aluFlags", "reg32:eax", "reg32:ebx"]);
});
