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
  deepStrictEqual(snapshot.flags.exitStores(), []);
  deepStrictEqual(snapshot.exitStores(), []);
});

test("JIT register value family models prefixes as bit extraction and insertion", () => {
  const state = createJitValueState();
  const inputEax = jitInputReg32Value("eax");

  deepStrictEqual(state.regs.readRegPart("eax", 0, 8), jitExtractBits(inputEax, 0, 8));
  deepStrictEqual(state.regs.readRegPart("eax", 8, 8), jitExtractBits(inputEax, 8, 8));

  state.regs.writeRegPart("eax", 0, 8, c32(0x7f));

  const snapshot = state.snapshot();
  const expected = jitInsertBits(inputEax, c32(0x7f), 0, 8);

  deepStrictEqual(snapshot.regs.readReg32("eax"), expected);
  deepStrictEqual(changedSlots(snapshot.slots.changedEntries()), ["reg32:eax"]);
  deepStrictEqual(snapshot.slots.changedEntries()[0]?.value, expected);
});

test("JIT register value snapshots derive full-register exit stores", () => {
  const state = createJitValueState();

  state.regs.writeReg32("eax", c32(0x1234_5678));

  deepStrictEqual(state.snapshot().regs.exitStores(), [{
    target: { kind: "reg32", reg: "eax" },
    value: c32(0x1234_5678)
  }]);
});

test("JIT register value snapshots derive low-byte exit stores", () => {
  const state = createJitValueState();

  state.regs.writeRegPart("eax", 0, 8, c32(0x7f));

  deepStrictEqual(state.snapshot().regs.exitStores(), [{
    target: { kind: "regPart", reg: "eax", bitOffset: 0, width: 8 },
    value: c32(0x7f)
  }]);
});

test("JIT register value snapshots derive high-byte exit stores", () => {
  const state = createJitValueState();

  state.regs.writeRegPart("eax", 8, 8, c32(0x7f));

  deepStrictEqual(state.snapshot().regs.exitStores(), [{
    target: { kind: "regPart", reg: "eax", bitOffset: 8, width: 8 },
    value: c32(0x7f)
  }]);
});

test("JIT register value snapshots derive word exit stores", () => {
  const state = createJitValueState();

  state.regs.writeRegPart("eax", 0, 16, c32(0x7788));

  deepStrictEqual(state.snapshot().regs.exitStores(), [{
    target: { kind: "regPart", reg: "eax", bitOffset: 0, width: 16 },
    value: c32(0x7788)
  }]);
});

test("JIT register value family simplifies prefix identity writes away", () => {
  const state = createJitValueState();

  state.regs.writeRegPart("eax", 0, 8, state.regs.readRegPart("eax", 0, 8));
  state.regs.writeRegPart("ebx", 8, 8, state.regs.readRegPart("ebx", 8, 8));
  state.regs.writeRegPart("ecx", 0, 16, state.regs.readRegPart("ecx", 0, 16));

  const snapshot = state.snapshot();

  deepStrictEqual(snapshot.regs.readReg32("eax"), jitInputReg32Value("eax"));
  deepStrictEqual(snapshot.regs.readReg32("ebx"), jitInputReg32Value("ebx"));
  deepStrictEqual(snapshot.regs.readReg32("ecx"), jitInputReg32Value("ecx"));
  deepStrictEqual(snapshot.slots.changedEntries(), []);
  deepStrictEqual(snapshot.regs.exitStores(), []);
});

test("JIT register value family lets later full writes replace prefix merges", () => {
  const state = createJitValueState();

  state.regs.writeRegPart("eax", 0, 8, c32(0x7f));
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
