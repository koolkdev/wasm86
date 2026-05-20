import {
  deepStrictEqual,
  strictEqual,
  test,
  IR_ALU_FLAG_MASKS,
  jitExtractBits,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  simplifyValue,
  createJitValueState,
  createJitValueStateFromSnapshot,
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

test("JIT value state reuses fallback canonical inputs by identity", () => {
  const state = createJitValueState();

  strictEqual(state.regs.readReg32("eax"), state.regs.readReg32("eax"));
  strictEqual(state.flags.readAluFlags(), state.flags.readAluFlags());

  const snapshot = state.snapshot();

  strictEqual(snapshot.regs.readReg32("eax"), state.regs.readReg32("eax"));
  strictEqual(snapshot.flags.readAluFlags(), state.flags.readAluFlags());
});

test("JIT value state full-slot writes preserve the exact value object", () => {
  const state = createJitValueState();
  const value = c32(0x1234);

  state.regs.writeReg32("eax", value);

  const snapshot = state.snapshot();
  const [entry] = snapshot.slots.changedEntries();

  strictEqual(snapshot.regs.readReg32("eax"), value);
  strictEqual(entry?.value, value);
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

test("JIT register value family canonicalizes aliases through the 32-bit base", () => {
  const state = createJitValueState();

  deepStrictEqual(state.regs.readReg8("al"), jitExtractBits(jitInputReg32Value("eax"), 0, 8));
  deepStrictEqual(state.regs.readReg16("ax"), jitExtractBits(jitInputReg32Value("eax"), 0, 16));

  state.regs.writeReg8("ah", c32(0x12));

  const snapshot = state.snapshot();
  const expected = jitInsertBits(jitInputReg32Value("eax"), c32(0x12), 8, 8);

  deepStrictEqual(snapshot.regs.readReg32("eax"), expected);
  deepStrictEqual(snapshot.regs.readReg8("ah"), jitExtractBits(expected, 8, 8));
  deepStrictEqual(simplifyValue(snapshot.regs.readReg8("ah")), c32(0x12));
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:eax"]);
});

test("JIT register value family tracks prefix identity writes conservatively", () => {
  const state = createJitValueState();

  state.regs.writeReg8("al", state.regs.readReg8("al"));
  state.regs.writeReg8("bh", state.regs.readReg8("bh"));
  state.regs.writeReg16("cx", state.regs.readReg16("cx"));

  const snapshot = state.snapshot();
  const expectedEax = jitInsertBits(jitInputReg32Value("eax"), jitExtractBits(jitInputReg32Value("eax"), 0, 8), 0, 8);
  const expectedEbx = jitInsertBits(jitInputReg32Value("ebx"), jitExtractBits(jitInputReg32Value("ebx"), 8, 8), 8, 8);
  const expectedEcx = jitInsertBits(jitInputReg32Value("ecx"), jitExtractBits(jitInputReg32Value("ecx"), 0, 16), 0, 16);

  deepStrictEqual(snapshot.regs.readReg32("eax"), expectedEax);
  deepStrictEqual(snapshot.regs.readReg32("ebx"), expectedEbx);
  deepStrictEqual(snapshot.regs.readReg32("ecx"), expectedEcx);
  deepStrictEqual(simplifyValue(snapshot.regs.readReg32("eax")), jitInputReg32Value("eax"));
  deepStrictEqual(simplifyValue(snapshot.regs.readReg32("ebx")), jitInputReg32Value("ebx"));
  deepStrictEqual(simplifyValue(snapshot.regs.readReg32("ecx")), jitInputReg32Value("ecx"));
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:eax", "reg32:ebx", "reg32:ecx"]);
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

test("JIT value state changed entries do not call recursive equality", () => {
  const state = createJitValueState();
  const baseline = state.regs.readReg32("eax");
  const wrappedInput = {
    kind: "extractBits",
    value: baseline,
    bitOffset: 0,
    width: 32
  } as const;

  state.regs.writeReg32("eax", wrappedInput);

  const snapshot = state.snapshot();
  const [entry] = snapshot.slots.changedEntries();

  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:eax"]);
  strictEqual(entry?.value, wrappedInput);
});

test("JIT value state snapshot-to-mutable reconstruction preserves state", () => {
  const state = createJitValueState();
  const baseline = state.regs.readReg32("eax");

  state.regs.writeReg32("eax", c32(1));

  const resumed = createJitValueStateFromSnapshot(state.snapshot());

  resumed.regs.writeReg32("eax", baseline);

  deepStrictEqual(resumed.snapshot().slots.changedEntries(), []);
});
