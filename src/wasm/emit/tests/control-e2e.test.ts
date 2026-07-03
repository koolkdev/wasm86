import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, memBinding, regBinding, type OperandBinding } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { x86StatusFlags } from "#x86/flags.js";
import type { WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { reg32, type EffectiveAddress, type MemOperand, type Reg32 } from "#x86/types.js";
import { HostExit, decodeExit } from "#wasm/exit.js";
import {
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
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

  strictEqual(exit.family, "host");
  strictEqual(exit.reason, HostExit.MEMORY_READ_FAULT);
  strictEqual(exit.payload, 0x10000);
  strictEqual(exit.detail, 4);
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
    const instruction = address === undefined ? ok(decodeBytes(bytes)) : ok(decodeBytes(bytes, address));

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
        return memBinding(effectiveAddressOf(operand));
    }
  });
}

function effectiveAddressOf(operand: MemOperand): EffectiveAddress {
  return {
    segment: operand.segment,
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
