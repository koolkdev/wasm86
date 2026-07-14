import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import {
  immBinding,
  memBinding,
  regBinding,
  staticMemSegment,
  type EffectiveAddressTerms,
  type OperandBinding
} from "#ir/operands.js";
import { defaultSegmentForBase } from "#core/segments.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { decodeBytes, ok as decodeOk } from "#core/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import { x86StatusFlags } from "#core/flags/definitions.js";
import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import { reg32, type MemOperand, type Reg32 } from "#core/types.js";
import { HostExit, decodeExit } from "#wasm/exit.js";
import { assertPageFaultException, readPageFaultExit } from "#wasm/tests/exit-fixtures.js";
import {
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";
import type { AluFlags } from "./reference.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const satisfies AluFlags;
const noFlagsSet = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const satisfies AluFlags;

// Control-flow cases with explicit eip, register, and flag expectations.

test("cmp + jcc taken continues at the target with flushed flags", async () => {
  // cmp eax, 5; je +0x20 — equal, so the branch is taken.
  const instructions = decodeSequence([
    [0x83, 0xf8, 0x05],
    [0x74, 0x20]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = { eax: 5, eip: instructions[0]!.address };
  const { stateView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), irBlockCompleted);
  assertState(
    stateView,
    { regs: { eax: 5 }, eip: 0x1025, flags: noFlagsSet },
    "jcc taken"
  );
  assertLazyFlagState(stateView, { kind: "SUB", width: 32, a: 5, b: 5 }, "jcc taken");
});

test("cmp + jcc not taken continues at the fall-through with flushed flags", async () => {
  // cmp eax, 5; je +0x20 — not equal, so execution falls through.
  const instructions = decodeSequence([
    [0x83, 0xf8, 0x05],
    [0x74, 0x20]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 6,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { stateView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), irBlockCompleted);
  assertState(
    stateView,
    { regs: { eax: 6 }, eip: instructions[1]!.nextEip, flags: allFlagsSet },
    "jcc not taken"
  );
  assertLazyFlagState(stateView, { kind: "SUB", width: 32, a: 6, b: 5 }, "jcc not taken");
});

test("jmp rel32 continues at the target with earlier pendings flushed", async () => {
  // mov ecx, 0x77; jmp +0x10.
  const instructions = decodeSequence([
    [0xb9, 0x77, 0x00, 0x00, 0x00],
    [0xe9, 0x10, 0x00, 0x00, 0x00]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = { eip: instructions[0]!.address, ...allFlagsSet };
  const { stateView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), irBlockCompleted);
  assertState(stateView, { regs: { ecx: 0x77 }, eip: 0x101a, flags: allFlagsSet }, "jmp rel32");
});

test("int exits host trap with the vector payload and pending state visible", async () => {
  // mov ecx, 0x77; int 0x21.
  const instructions = decodeSequence([
    [0xb9, 0x77, 0x00, 0x00, 0x00],
    [0xcd, 0x21]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = { eip: instructions[0]!.address, ...allFlagsSet };
  const { stateView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  const exit = decodeExit(run());

  strictEqual(exit.family, "host");
  strictEqual(exit.reason, HostExit.TRAP);
  strictEqual(exit.payload, 0x21);
  assertState(stateView, { regs: { ecx: 0x77 }, eip: instructions[1]!.nextEip, flags: allFlagsSet }, "int");
});

test("int3 exits host trap vector 3 after the one-byte instruction", async () => {
  const instruction = decodeOk(decodeBytes([0xcc]));
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, { eip: instruction.address, eax: 0x77, ...allFlagsSet });

  const exit = decodeExit(run());

  strictEqual(exit.family, "host");
  strictEqual(exit.reason, HostExit.TRAP);
  strictEqual(exit.payload, 3);
  assertState(stateView, { regs: { eax: 0x77 }, eip: instruction.nextEip, flags: allFlagsSet }, "int3");
});

test("into traps vector 4 only when OF is set", async () => {
  const instruction = decodeOk(decodeBytes([0xce]));

  {
    const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

    writeWasmCpuStateSnapshot(stateView, { eip: instruction.address, eax: 0x77, ...noFlagsSet });

    strictEqual(run(), irBlockCompleted);
    assertState(stateView, { regs: { eax: 0x77 }, eip: instruction.nextEip, flags: noFlagsSet }, "into not taken");
  }

  {
    const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

    writeWasmCpuStateSnapshot(stateView, { eip: instruction.address, eax: 0x77, ...noFlagsSet, OF: 1 });

    const exit = decodeExit(run());

    strictEqual(exit.family, "host");
    strictEqual(exit.reason, HostExit.TRAP);
    strictEqual(exit.payload, 4);
    assertState(
      stateView,
      { regs: { eax: 0x77 }, eip: instruction.nextEip, flags: { ...noFlagsSet, OF: 1 } },
      "into taken"
    );
  }
});

test("into resolves lazy overflow from a prior add before deciding to trap", async () => {
  // add eax, ebx; into. Explicit OF starts clear, so the trap depends on the
  // lazy ADD flag source produced by the first instruction.
  const instructions = decodeSequence([
    [0x01, 0xd8],
    [0xce]
  ]);
  const { stateView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0x7fff_ffff,
    ebx: 1,
    eip: instructions[0]!.address,
    ...noFlagsSet
  });

  const exit = decodeExit(run());

  strictEqual(exit.family, "host");
  strictEqual(exit.reason, HostExit.TRAP);
  strictEqual(exit.payload, 4);
  assertState(
    stateView,
    { regs: { eax: 0x8000_0000, ebx: 1 }, eip: instructions[1]!.nextEip, flags: noFlagsSet },
    "into lazy add overflow"
  );
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 0x7fff_ffff, b: 1 }, "into lazy add overflow");
});

test("ecx loop controls count down, branch, and leave flags untouched", async () => {
  const cases = [
    {
      name: "loop",
      bytes: [0xe2, 0x20],
      initial: { ecx: 1, ...allFlagsSet },
      expectedEcx: 0,
      expectedEip: 0x1002,
      expectedFlags: allFlagsSet
    },
    {
      name: "loope taken",
      bytes: [0xe1, 0x20],
      initial: { ecx: 2, ...noFlagsSet, ZF: 1 },
      expectedEcx: 1,
      expectedEip: 0x1022,
      expectedFlags: { ...noFlagsSet, ZF: 1 }
    },
    {
      name: "loope stops on zf clear",
      bytes: [0xe1, 0x20],
      initial: { ecx: 2, ...noFlagsSet },
      expectedEcx: 1,
      expectedEip: 0x1002,
      expectedFlags: noFlagsSet
    },
    {
      name: "loopne taken",
      bytes: [0xe0, 0x20],
      initial: { ecx: 2, ...noFlagsSet },
      expectedEcx: 1,
      expectedEip: 0x1022,
      expectedFlags: noFlagsSet
    },
    {
      name: "loopne stops on zf set",
      bytes: [0xe0, 0x20],
      initial: { ecx: 2, ...noFlagsSet, ZF: 1 },
      expectedEcx: 1,
      expectedEip: 0x1002,
      expectedFlags: { ...noFlagsSet, ZF: 1 }
    }
  ] as const;

  for (const entry of cases) {
    const instruction = decodeOk(decodeBytes(entry.bytes));
    const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

    writeWasmCpuStateSnapshot(stateView, { eip: instruction.address, ...entry.initial });

    strictEqual(run(), irBlockCompleted, entry.name);
    assertState(
      stateView,
      { regs: { ecx: entry.expectedEcx }, eip: entry.expectedEip, flags: entry.expectedFlags },
      entry.name
    );
  }
});

test("jecxz branches exactly when ecx is zero without touching flags", async () => {
  const instruction = decodeOk(decodeBytes([0xe3, 0x20]));

  for (const [name, ecx, expectedEip] of [
    ["taken", 0, 0x1022],
    ["not taken", 1, instruction.nextEip]
  ] as const) {
    const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

    writeWasmCpuStateSnapshot(stateView, { eip: instruction.address, ecx, ...allFlagsSet });

    strictEqual(run(), irBlockCompleted, name);
    assertState(stateView, { regs: { ecx }, eip: expectedEip, flags: allFlagsSet }, `jecxz ${name}`);
  }
});

test("a branch composes with a fault edge in one block", async () => {
  // mov ecx, [ebx]; je +0x20 with ZF preset: the load's inline fault
  // edge coexists with the branch's inline if/else arms.
  const instructions = decodeSequence([
    [0x8b, 0x0b],
    [0x74, 0x20]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = { ebx: 0x20, eip: instructions[0]!.address, ZF: 1 };
  const { stateView, guestView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 0x55, true);

  strictEqual(run(), irBlockCompleted);
  assertState(
    stateView,
    { regs: { ebx: 0x20, ecx: 0x55 }, eip: 0x1024, flags: { CF: 0, PF: 0, AF: 0, ZF: 1, SF: 0, OF: 0 } },
    "load then branch"
  );
});

test("a faulting load before a branch exits through its fault edge", async () => {
  // The same block with ebx one past the guest: the read guard's inline
  // fault body exits before the branch runs.
  const instructions = decodeSequence([
    [0x8b, 0x0b],
    [0x74, 0x20]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: 0x10000,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { stateView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  const exit = decodeExit(run());
  const expected = readPageFaultExit(0x10000);

  strictEqual(exit.family, "cpuException");
  if (exit.family === "cpuException") {
    strictEqual(exit.exception.kind, expected.exception.kind);
    assertPageFaultException(exit.exception);
    assertPageFaultException(expected.exception);
    strictEqual(exit.exception.linearAddress, expected.exception.linearAddress);
    strictEqual(exit.exception.errorCode, expected.exception.errorCode);
  }
  assertState(
    stateView,
    { regs: { ebx: 0x10000 }, eip: instructions[0]!.address, flags: allFlagsSet },
    "faulting load before branch"
  );
});

function blockOf(instructions: readonly IsaDecodedInstruction[]): IrBlock {
  const builder = createIrBlockBuilder();

  for (const instruction of instructions) {
    builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), loc(instruction.address, instruction.nextEip));
  }

  return builder.finish();
}

function decodeSequence(byteLists: readonly (readonly number[])[]): readonly IsaDecodedInstruction[] {
  const instructions: IsaDecodedInstruction[] = [];
  let address: number | undefined;

  for (const bytes of byteLists) {
    const instruction = address === undefined ? decodeOk(decodeBytes(bytes)) : decodeOk(decodeBytes(bytes, address));

    instructions.push(instruction);
    address = instruction.nextEip;
  }

  return instructions;
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    switch (operand.kind) {
      case "reg":
        if (operand.alias.width !== 32) {
          throw new Error("only 32-bit register operands are bound in the control e2e");
        }

        return regBinding(operand.alias.base);
      case "segment":
        throw new Error("segment operands not supported in the control e2e");
      case "imm":
        return immBinding(operand.value);
      case "relTarget":
        // The decoder already resolved the absolute target.
        return immBinding(operand.target);
      case "mem":
        return memBinding(
          effectiveAddressTermsOf(operand),
          staticMemSegment(operand.segment ?? defaultSegmentForBase(operand.base))
        );
    }
  });
}

function effectiveAddressTermsOf(operand: MemOperand): EffectiveAddressTerms {
  return {
    base: operand.base,
    index: operand.index,
    scale: operand.scale,
    disp: operand.disp
  };
}

function assertState(
  stateView: DataView,
  expected: Readonly<{ regs: Partial<Record<Reg32, number>>; eip: number; flags: AluFlags }>,
  label: string
): void {
  for (const name of reg32) {
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel(name)), expected.regs[name] ?? 0, `${label} ${name}`);
  }

  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), expected.eip, `${label} eip`);

  for (const flag of x86StatusFlags) {
    strictEqual(readWasmCpuFlagByte(stateView, flag), expected.flags[flag], `${label} ${flag}`);
  }
}
