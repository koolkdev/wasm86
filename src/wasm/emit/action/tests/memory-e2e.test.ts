import { strictEqual } from "node:assert";
import { test } from "node:test";

import { executeDirectInstruction } from "#backends/direct/execute.js";
import { createActionBuilder } from "#ir/action/builder.js";
import { immBinding, memBinding, regBinding, type OperandBinding } from "#ir/action/operands.js";
import { eipChannel, gprChannel } from "#ir/action/slots.js";
import type { ActionBlock } from "#ir/action/types.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { StopReason, type RunResult } from "#x86/execution/run-result.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { ArrayBufferGuestMemory } from "#x86/memory/guest-memory.js";
import { writeGuestU32 } from "#x86/memory/tests/helpers.js";
import { createCpuState, getFlag, type CpuState } from "#x86/state/cpu-state.js";
import { reg32, type EffectiveAddress, type MemOperand, type RegName } from "#x86/types.js";
import { decodeExit, ExitReason } from "#wasm/exit.js";
import { readWasmFlagByte, readWasmStateChannel, writeWasmCpuState } from "#wasm/state-layout.js";
import { instantiateActionBlock } from "./harness.js";

// Stage 5's end-to-end slice: memory operands through guards, guest access,
// and fault edges, with the direct backend executing the same decoded
// instructions on a CpuState plus an equally sized guest memory as the
// reference — including the fault path, where 05b's instruction-level
// atomicity is the contract both sides must meet.

// One wasm page, so the harness guest and the reference memory agree on
// where faults start.
const guestByteLength = 0x10000;

const allArithmeticEflags = 0x8d5;

test("mov r32, [ebx+disp] loads the guest cell", async () => {
  const instruction = ok(decodeBytes([0x8b, 0x43, 0x04]));
  const initial: Partial<CpuState> = { ebx: 0x20, eip: instruction.address, eflags: allArithmeticEflags };
  const { refState, memory } = directReference(initial);
  const { stateView, guestView, run } = await instantiateActionBlock(blockOf([instruction]));

  writeWasmCpuState(stateView, initial);
  guestView.setUint32(0x24, 0x1122_3344, true);
  writeGuestU32(memory, 0x24, 0x1122_3344);

  strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  strictEqual(decodeExit(run()).exitReason, ExitReason.FALLTHROUGH);
  strictEqual(readRegister(stateView, "eax"), 0x1122_3344);
  assertMatchesReference(stateView, refState, "mov r32, [ebx+4]");
});

test("mov [ebx+disp], r32 stores the guest cell", async () => {
  const instruction = ok(decodeBytes([0x89, 0x43, 0x04]));
  const initial: Partial<CpuState> = {
    eax: 0xcafe_1234,
    ebx: 0x20,
    eip: instruction.address,
    eflags: allArithmeticEflags
  };
  const { refState, memory } = directReference(initial);
  const { stateView, guestView, run } = await instantiateActionBlock(blockOf([instruction]));

  writeWasmCpuState(stateView, initial);

  strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  strictEqual(decodeExit(run()).exitReason, ExitReason.FALLTHROUGH);
  strictEqual(guestView.getUint32(0x24, true), 0xcafe_1234);
  strictEqual(guestView.getUint32(0x24, true), readReferenceU32(memory, 0x24));
  assertMatchesReference(stateView, refState, "mov [ebx+4], r32");
});

test("add [mem], r32 read-modify-writes the cell with reference flags", async () => {
  // add [eax], ebx with a wrap to zero: CF and ZF both come out set.
  const instruction = ok(decodeBytes([0x01, 0x18]));
  const initial: Partial<CpuState> = {
    eax: 0x20,
    ebx: 0xffff_ffff,
    eip: instruction.address,
    eflags: 0
  };
  const { refState, memory } = directReference(initial);
  const { stateView, guestView, run } = await instantiateActionBlock(blockOf([instruction]));

  writeWasmCpuState(stateView, initial);
  guestView.setUint32(0x20, 1, true);
  writeGuestU32(memory, 0x20, 1);

  strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  strictEqual(decodeExit(run()).exitReason, ExitReason.FALLTHROUGH);
  strictEqual(guestView.getUint32(0x20, true), 0);
  strictEqual(guestView.getUint32(0x20, true), readReferenceU32(memory, 0x20));
  assertMatchesReference(stateView, refState, "add [eax], ebx");
});

test("add r32, [mem] loads the operand with reference flags", async () => {
  const instruction = ok(decodeBytes([0x03, 0x18]));
  const initial: Partial<CpuState> = {
    eax: 0x20,
    ebx: 0x7fff_ffff,
    eip: instruction.address,
    eflags: 0
  };
  const { refState, memory } = directReference(initial);
  const { stateView, guestView, run } = await instantiateActionBlock(blockOf([instruction]));

  writeWasmCpuState(stateView, initial);
  guestView.setUint32(0x20, 1, true);
  writeGuestU32(memory, 0x20, 1);

  strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  strictEqual(decodeExit(run()).exitReason, ExitReason.FALLTHROUGH);
  // 0x7fffffff + 1 overflows signed: SF and OF per the reference.
  strictEqual(readRegister(stateView, "ebx"), 0x8000_0000);
  assertMatchesReference(stateView, refState, "add ebx, [eax]");
});

test("byte and word guest accesses load and store at their widths", async () => {
  // movzx eax, byte [ebx]; movsx ecx, byte [ebx]; mov byte [ebx+1], 0x7f;
  // mov word [ebx+2], 0xbeef.
  const instructions = decodeSequence([
    [0x0f, 0xb6, 0x03],
    [0x0f, 0xbe, 0x0b],
    [0xc6, 0x43, 0x01, 0x7f],
    [0x66, 0xc7, 0x43, 0x02, 0xef, 0xbe]
  ]);
  const initial: Partial<CpuState> = { ebx: 0x20, eip: instructions[0]!.address, eflags: allArithmeticEflags };
  const { refState, memory } = directReference(initial);
  const { stateView, guestView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);
  guestView.setUint32(0x20, 0x1122_33f6, true);
  writeGuestU32(memory, 0x20, 0x1122_33f6);

  for (const instruction of instructions) {
    strictEqual(executeDirectInstruction(refState, instruction, { memory }).stopReason, StopReason.NONE);
  }

  strictEqual(decodeExit(run()).exitReason, ExitReason.FALLTHROUGH);
  strictEqual(readRegister(stateView, "eax"), 0xf6);
  strictEqual(readRegister(stateView, "ecx"), 0xffff_fff6);
  strictEqual(guestView.getUint32(0x20, true), 0xbeef_7ff6);
  strictEqual(guestView.getUint32(0x20, true), readReferenceU32(memory, 0x20));
  assertMatchesReference(stateView, refState, "byte and word accesses");
});

test("a read fault reports the faulting eip and keeps earlier instructions' state", async () => {
  // mov ecx, 0x77; mov eax, [ebx] with ebx one past the guest.
  const instructions = decodeSequence([
    [0xb9, 0x77, 0x00, 0x00, 0x00],
    [0x8b, 0x03]
  ]);
  const initial: Partial<CpuState> = {
    eax: 0x1234_5678,
    ebx: guestByteLength,
    eip: instructions[0]!.address,
    eflags: allArithmeticEflags
  };
  const { refState, memory } = directReference(initial);
  const { stateView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);

  strictEqual(executeDirectInstruction(refState, instructions[0]!, { memory }).stopReason, StopReason.NONE);

  const refResult = executeDirectInstruction(refState, instructions[1]!, { memory });

  strictEqual(refResult.stopReason, StopReason.MEMORY_FAULT);
  assertFaultExit(run(), ExitReason.MEMORY_READ_FAULT, refResult, "read fault");
  strictEqual(readRegister(stateView, "ecx"), 0x77);
  strictEqual(readRegister(stateView, "eax"), 0x1234_5678);
  strictEqual(readWasmStateChannel(stateView, eipChannel), instructions[1]!.address);
  assertMatchesReference(stateView, refState, "read fault");
});

test("a write fault leaves guest memory untouched", async () => {
  // mov [ebx], eax with the range crossing the guest end.
  const instruction = ok(decodeBytes([0x89, 0x03]));
  const initial: Partial<CpuState> = {
    eax: 0xdead_beef,
    ebx: guestByteLength - 2,
    eip: instruction.address,
    eflags: allArithmeticEflags
  };
  const { refState, memory } = directReference(initial);
  const { stateView, guestView, run } = await instantiateActionBlock(blockOf([instruction]));

  writeWasmCpuState(stateView, initial);

  const refResult = executeDirectInstruction(refState, instruction, { memory });

  strictEqual(refResult.stopReason, StopReason.MEMORY_FAULT);
  assertFaultExit(run(), ExitReason.MEMORY_WRITE_FAULT, refResult, "write fault");
  strictEqual(guestView.getUint32(guestByteLength - 4, true), 0);
  assertMatchesReference(stateView, refState, "write fault");
});

test("a narrow access faults with its byte length", async () => {
  // movzx eax, byte [ebx] one past the guest.
  const instruction = ok(decodeBytes([0x0f, 0xb6, 0x03]));
  const initial: Partial<CpuState> = {
    ebx: guestByteLength,
    eip: instruction.address,
    eflags: allArithmeticEflags
  };
  const { refState, memory } = directReference(initial);
  const { stateView, run } = await instantiateActionBlock(blockOf([instruction]));

  writeWasmCpuState(stateView, initial);

  const refResult = executeDirectInstruction(refState, instruction, { memory });

  strictEqual(refResult.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(refResult.faultSize, 1);
  assertFaultExit(run(), ExitReason.MEMORY_READ_FAULT, refResult, "byte fault");
  assertMatchesReference(stateView, refState, "byte fault");
});

test("a faulting pop [mem] restores esp to its pre-instruction value", async () => {
  // add esp, 4; pop [ebx] with an out-of-bounds destination: the write guard
  // faults after the template advanced esp, so the edge must flush the
  // boundary esp — the add's result, not the pop's increment.
  const instructions = decodeSequence([
    [0x83, 0xc4, 0x04],
    [0x8f, 0x03]
  ]);
  const initial: Partial<CpuState> = {
    ebx: guestByteLength - 2,
    esp: 0x1c,
    eip: instructions[0]!.address,
    eflags: allArithmeticEflags
  };
  const { refState, memory } = directReference(initial);
  const { stateView, guestView, run } = await instantiateActionBlock(blockOf(instructions));

  writeWasmCpuState(stateView, initial);
  guestView.setUint32(0x20, 0xcafe_1234, true);
  writeGuestU32(memory, 0x20, 0xcafe_1234);

  strictEqual(executeDirectInstruction(refState, instructions[0]!, { memory }).stopReason, StopReason.NONE);

  const refResult = executeDirectInstruction(refState, instructions[1]!, { memory });

  strictEqual(refResult.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(refState.esp, 0x20);

  assertFaultExit(run(), ExitReason.MEMORY_WRITE_FAULT, refResult, "pop [mem] fault");
  strictEqual(readRegister(stateView, "esp"), 0x20);
  strictEqual(readWasmStateChannel(stateView, eipChannel), instructions[1]!.address);
  strictEqual(guestView.getUint32(0x20, true), 0xcafe_1234);
  assertMatchesReference(stateView, refState, "pop [mem] fault");
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
  return { refState: createCpuState(initial), memory: new ArrayBufferGuestMemory(guestByteLength) };
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    switch (operand.kind) {
      case "reg":
        if (operand.alias.width !== 32) {
          throw new Error("only 32-bit register operands are bound in the memory e2e");
        }

        return regBinding(operand.alias.base);
      case "imm":
        return immBinding(operand.value);
      case "mem":
        return memBinding(effectiveAddressOf(operand));
      case "relTarget":
        throw new Error("relTarget operands not supported in the memory e2e");
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

function readReferenceU32(memory: ArrayBufferGuestMemory, address: number): number {
  const read = memory.readU32(address);

  strictEqual(read.ok, true, `reference read at ${address}`);
  return read.ok ? read.value : 0;
}

function assertFaultExit(exit: bigint, reason: ExitReason, reference: RunResult, label: string): void {
  const decoded = decodeExit(exit);

  strictEqual(decoded.exitReason, reason, `${label} reason`);
  strictEqual(decoded.payload, reference.faultAddress, `${label} payload`);
  strictEqual(decoded.detail, reference.faultSize, `${label} fault size`);
}

function assertMatchesReference(stateView: DataView, refState: CpuState, label: string): void {
  for (const name of reg32) {
    strictEqual(readWasmStateChannel(stateView, gprChannel(name)), refState[name], `${label} ${name}`);
  }

  strictEqual(readWasmStateChannel(stateView, eipChannel), refState.eip, `${label} eip`);

  for (const flag of x86ArithmeticFlags) {
    strictEqual(readWasmFlagByte(stateView, flag), getFlag(refState, flag) ? 1 : 0, `${label} ${flag}`);
  }
}
