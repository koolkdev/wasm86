import { strictEqual } from "node:assert";
import { test } from "node:test";

import { executeDirectInstruction } from "#backends/direct/execute.js";
import { createActionBuilder } from "#ir/action/builder.js";
import { immBinding, memBinding, regBinding, type OperandBinding } from "#ir/action/operands.js";
import { eipChannel, gprChannel } from "#ir/action/slots.js";
import type { ActionBlock } from "#ir/action/types.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { StopReason } from "#x86/execution/run-result.js";
import { x86Flags } from "#x86/flags.js";
import { ArrayBufferGuestMemory } from "#x86/memory/guest-memory.js";
import { writeGuestU32 } from "#x86/memory/tests/helpers.js";
import { createCpuState, getFlag, type CpuState } from "#x86/state/cpu-state.js";
import { reg32, type EffectiveAddress, type MemOperand, type RegName } from "#x86/types.js";
import { decodeExit, ExitReason } from "#wasm/exit.js";
import { readWasmFlagByte, readWasmStateChannel, writeWasmCpuState } from "#wasm/state-layout.js";
import { actionBlockCompleted, instantiateActionBlock } from "./harness.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

// Stage 6's end-to-end slice: jumps, conditional branches, and host traps,
// with the direct backend executing the same decoded instructions as the
// reference for eip, registers, and flags on every path.


test("cmp + jcc taken continues at the target with flushed flags", async () => {
  // cmp eax, 5; je +0x20 — equal, so the branch is taken.
  const instructions = decodeSequence([
    [0x83, 0xf8, 0x05],
    [0x74, 0x20]
  ]);
  const initial: Partial<CpuState> = { eax: 5, eip: instructions[0]!.address };
  const { refState, memory } = directReference(initial);
  const { stateView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);

  for (const instruction of instructions) {
    strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  }

  strictEqual(refState.eip, 0x1025);
  strictEqual(run(), actionBlockCompleted);
  assertMatchesReference(stateView, refState, "jcc taken");
});

test("cmp + jcc not taken continues at the fall-through with flushed flags", async () => {
  // cmp eax, 5; je +0x20 — not equal, so execution falls through.
  const instructions = decodeSequence([
    [0x83, 0xf8, 0x05],
    [0x74, 0x20]
  ]);
  const initial: Partial<CpuState> = {
    eax: 6,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { refState, memory } = directReference(initial);
  const { stateView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);

  for (const instruction of instructions) {
    strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  }

  strictEqual(refState.eip, instructions[1]!.nextEip);
  strictEqual(run(), actionBlockCompleted);
  assertMatchesReference(stateView, refState, "jcc not taken");
});

test("jmp rel32 continues at the target with earlier pendings flushed", async () => {
  // mov ecx, 0x77; jmp +0x10.
  const instructions = decodeSequence([
    [0xb9, 0x77, 0x00, 0x00, 0x00],
    [0xe9, 0x10, 0x00, 0x00, 0x00]
  ]);
  const initial: Partial<CpuState> = { eip: instructions[0]!.address, ...allFlagsSet };
  const { refState, memory } = directReference(initial);
  const { stateView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);

  for (const instruction of instructions) {
    strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  }

  strictEqual(refState.eip, 0x101a);
  strictEqual(run(), actionBlockCompleted);
  strictEqual(readRegister(stateView, "ecx"), 0x77);
  assertMatchesReference(stateView, refState, "jmp rel32");
});

test("int exits host trap with the vector payload and pending state visible", async () => {
  // mov ecx, 0x77; int 0x21.
  const instructions = decodeSequence([
    [0xb9, 0x77, 0x00, 0x00, 0x00],
    [0xcd, 0x21]
  ]);
  const initial: Partial<CpuState> = { eip: instructions[0]!.address, ...allFlagsSet };
  const { refState, memory } = directReference(initial);
  const { stateView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);

  strictEqual(executeDirectInstruction(refState, instructions[0]!, { memory }).stopReason, StopReason.NONE);

  const refResult = executeDirectInstruction(refState, instructions[1]!, { memory });

  strictEqual(refResult.stopReason, StopReason.HOST_TRAP);
  strictEqual(refResult.trapVector, 0x21);

  const exit = decodeExit(run());

  strictEqual(exit.exitReason, ExitReason.HOST_TRAP);
  strictEqual(exit.payload, refResult.trapVector);
  strictEqual(readRegister(stateView, "ecx"), 0x77);
  strictEqual(readWasmStateChannel(stateView, eipChannel), instructions[1]!.nextEip);
  assertMatchesReference(stateView, refState, "int");
});

test("a branch composes with a fault edge in one block", async () => {
  // mov ecx, [ebx]; je +0x20 with ZF preset: the load's fault edge nests
  // around the branch's edges, and the taken branch crosses all of them.
  const instructions = decodeSequence([
    [0x8b, 0x0b],
    [0x74, 0x20]
  ]);
  const initial: Partial<CpuState> = { ebx: 0x20, eip: instructions[0]!.address, ZF: 1 };
  const { refState, memory } = directReference(initial);
  const { stateView, guestView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);
  guestView.setUint32(0x20, 0x55, true);
  writeGuestU32(memory, 0x20, 0x55);

  for (const instruction of instructions) {
    strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  }

  strictEqual(refState.eip, 0x1024);
  strictEqual(run(), actionBlockCompleted);
  strictEqual(readRegister(stateView, "ecx"), 0x55);
  assertMatchesReference(stateView, refState, "load then branch");
});

test("a faulting load before a branch exits through its fault edge", async () => {
  // The same block with ebx one past the guest: the read guard's br_if must
  // still find its edge with the branch's notTaken edge nested innermost.
  const instructions = decodeSequence([
    [0x8b, 0x0b],
    [0x74, 0x20]
  ]);
  const initial: Partial<CpuState> = {
    ebx: 0x10000,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { refState, memory } = directReference(initial);
  const { stateView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);

  const refResult = executeDirectInstruction(refState, instructions[0]!, { memory });

  strictEqual(refResult.stopReason, StopReason.MEMORY_FAULT);

  const exit = decodeExit(run());

  strictEqual(exit.exitReason, ExitReason.MEMORY_READ_FAULT);
  strictEqual(exit.payload, refResult.faultAddress);
  strictEqual(exit.detail, refResult.faultSize);
  strictEqual(readWasmStateChannel(stateView, eipChannel), instructions[0]!.address);
  assertMatchesReference(stateView, refState, "faulting load before branch");
});

function blockOf(instructions: readonly IsaDecodedInstruction[]): ActionBlock {
  const builder = createActionBuilder();

  for (const instruction of instructions) {
    builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), {
      eip: instruction.address,
      nextEip: instruction.nextEip
    });
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

function directReference(
  initial: Partial<CpuState>
): Readonly<{ refState: CpuState; memory: ArrayBufferGuestMemory }> {
  return { refState: createCpuState(initial), memory: new ArrayBufferGuestMemory(0x10000) };
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    switch (operand.kind) {
      case "reg":
        if (operand.alias.width !== 32) {
          throw new Error("only 32-bit register operands are bound in the control e2e");
        }

        return regBinding(operand.alias.base);
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
    ...(operand.base === undefined ? {} : { base: operand.base }),
    ...(operand.index === undefined ? {} : { index: operand.index }),
    scale: operand.scale,
    disp: operand.disp
  };
}

function readRegister(view: DataView, name: RegName): number {
  return readWasmStateChannel(view, gprChannel(name));
}

function assertMatchesReference(stateView: DataView, refState: CpuState, label: string): void {
  for (const name of reg32) {
    strictEqual(readWasmStateChannel(stateView, gprChannel(name)), refState[name], `${label} ${name}`);
  }

  strictEqual(readWasmStateChannel(stateView, eipChannel), refState.eip, `${label} eip`);

  for (const flag of x86Flags) {
    strictEqual(readWasmFlagByte(stateView, flag), getFlag(refState, flag) ? 1 : 0, `${label} ${flag}`);
  }
}
