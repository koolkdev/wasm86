import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, memBinding, regBinding, type OperandBinding } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { x86Flags } from "#x86/flags.js";
import type { WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { reg32, type EffectiveAddress, type MemOperand, type Reg32 } from "#x86/types.js";
import { decodeExit, ExitReason } from "#wasm/exit.js";
import { readWasmCpuFlagByte, readWasmCpuStateChannel, writeWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";
import { aluReference, type AluFlags } from "./reference.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const satisfies AluFlags;

// Memory cases with explicit state, guest bytes, and fault expectations.

// One wasm page, so the first out-of-bounds byte is at guestByteLength.
const guestByteLength = 0x10000;

test("mov r32, [ebx+disp] loads the guest cell", async () => {
  const instruction = ok(decodeBytes([0x8b, 0x43, 0x04]));
  const initial: Partial<WasmCpuStateSnapshot> = { ebx: 0x20, eip: instruction.address, ...allFlagsSet };
  const { stateView, guestView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x24, 0x1122_3344, true);

  strictEqual(run(), irBlockCompleted);
  assertState(
    stateView,
    { regs: { eax: 0x1122_3344, ebx: 0x20 }, eip: instruction.nextEip, flags: allFlagsSet },
    "mov r32, [ebx+4]"
  );
});

test("mov [ebx+disp], r32 stores the guest cell", async () => {
  const instruction = ok(decodeBytes([0x89, 0x43, 0x04]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xcafe_1234,
    ebx: 0x20,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), irBlockCompleted);
  strictEqual(guestView.getUint32(0x24, true), 0xcafe_1234);
  assertState(
    stateView,
    { regs: { eax: 0xcafe_1234, ebx: 0x20 }, eip: instruction.nextEip, flags: allFlagsSet },
    "mov [ebx+4], r32"
  );
});

test("add [mem], r32 read-modify-writes the cell with reference flags", async () => {
  // add [eax], ebx with a wrap to zero: CF and ZF both come out set.
  const instruction = ok(decodeBytes([0x01, 0x18]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0x20,
    ebx: 0xffff_ffff,
    eip: instruction.address
  };
  const { stateView, guestView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 1, true);

  // dest = [eax] (1), src = ebx (0xffffffff): the cell wraps to zero.
  const reference = aluReference("add", 32, 1, 0xffff_ffff);

  strictEqual(run(), irBlockCompleted);
  strictEqual(guestView.getUint32(0x20, true), reference.result);
  assertState(
    stateView,
    { regs: { eax: 0x20, ebx: 0xffff_ffff }, eip: instruction.nextEip, flags: reference.flags },
    "add [eax], ebx"
  );
});

test("add r32, [mem] loads the operand with reference flags", async () => {
  const instruction = ok(decodeBytes([0x03, 0x18]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0x20,
    ebx: 0x7fff_ffff,
    eip: instruction.address
  };
  const { stateView, guestView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 1, true);

  // dest = ebx (0x7fffffff), src = [eax] (1): overflows signed, so SF and OF.
  const reference = aluReference("add", 32, 0x7fff_ffff, 1);

  strictEqual(run(), irBlockCompleted);
  assertState(
    stateView,
    { regs: { eax: 0x20, ebx: reference.result }, eip: instruction.nextEip, flags: reference.flags },
    "add ebx, [eax]"
  );
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
  const initial: Partial<WasmCpuStateSnapshot> = { ebx: 0x20, eip: instructions[0]!.address, ...allFlagsSet };
  const { stateView, guestView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 0x1122_33f6, true);

  strictEqual(run(), irBlockCompleted);
  strictEqual(guestView.getUint32(0x20, true), 0xbeef_7ff6);
  assertState(
    stateView,
    {
      regs: { eax: 0xf6, ecx: 0xffff_fff6, ebx: 0x20 },
      eip: instructions[3]!.nextEip,
      flags: allFlagsSet
    },
    "byte and word accesses"
  );
});

test("a read fault reports the faulting eip and keeps earlier instructions' state", async () => {
  // mov ecx, 0x77; mov eax, [ebx] with ebx one past the guest.
  const instructions = decodeSequence([
    [0xb9, 0x77, 0x00, 0x00, 0x00],
    [0x8b, 0x03]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0x1234_5678,
    ebx: guestByteLength,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { stateView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), ExitReason.MEMORY_READ_FAULT, guestByteLength, 4, "read fault");
  assertState(
    stateView,
    {
      // ecx is committed; the faulting load leaves eax at its initial value.
      regs: { ecx: 0x77, eax: 0x1234_5678, ebx: guestByteLength },
      eip: instructions[1]!.address,
      flags: allFlagsSet
    },
    "read fault"
  );
});

test("a write fault leaves guest memory untouched", async () => {
  // mov [ebx], eax with the range crossing the guest end.
  const instruction = ok(decodeBytes([0x89, 0x03]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xdead_beef,
    ebx: guestByteLength - 2,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), ExitReason.MEMORY_WRITE_FAULT, guestByteLength - 2, 4, "write fault");
  strictEqual(guestView.getUint32(guestByteLength - 4, true), 0);
  assertState(
    stateView,
    { regs: { eax: 0xdead_beef, ebx: guestByteLength - 2 }, eip: instruction.address, flags: allFlagsSet },
    "write fault"
  );
});

test("a narrow access faults with its byte length", async () => {
  // movzx eax, byte [ebx] one past the guest.
  const instruction = ok(decodeBytes([0x0f, 0xb6, 0x03]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: guestByteLength,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), ExitReason.MEMORY_READ_FAULT, guestByteLength, 1, "byte fault");
  assertState(
    stateView,
    { regs: { ebx: guestByteLength }, eip: instruction.address, flags: allFlagsSet },
    "byte fault"
  );
});

test("a faulting pop [mem] restores esp to its pre-instruction value", async () => {
  // add esp, 4; pop [ebx] with an out-of-bounds destination: the write guard
  // faults after the template advanced esp, so the edge must flush the
  // boundary esp — the add's result, not the pop's increment.
  const instructions = decodeSequence([
    [0x83, 0xc4, 0x04],
    [0x8f, 0x03]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: guestByteLength - 2,
    esp: 0x1c,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateIrBlock(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 0xcafe_1234, true);

  // The add commits esp = 0x20 and its flags before the pop faults.
  const reference = aluReference("add", 32, 0x1c, 4);

  assertFaultExit(run(), ExitReason.MEMORY_WRITE_FAULT, guestByteLength - 2, 4, "pop [mem] fault");
  strictEqual(guestView.getUint32(0x20, true), 0xcafe_1234);
  assertState(
    stateView,
    { regs: { esp: reference.result, ebx: guestByteLength - 2 }, eip: instructions[1]!.address, flags: reference.flags },
    "pop [mem] fault"
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

function assertFaultExit(exit: bigint, reason: ExitReason, address: number, size: number, label: string): void {
  const decoded = decodeExit(exit);

  strictEqual(decoded.exitReason, reason, `${label} reason`);
  strictEqual(decoded.payload, address, `${label} payload`);
  strictEqual(decoded.detail, size, `${label} fault size`);
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

  for (const flag of x86Flags) {
    strictEqual(readWasmCpuFlagByte(stateView, flag), expected.flags[flag], `${label} ${flag}`);
  }
}
