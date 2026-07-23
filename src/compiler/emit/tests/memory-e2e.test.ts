import { strictEqual } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { createInstructionFunction } from "./instruction-function.js";
import {
  immBinding,
  memBinding,
  regBinding,
  staticMemSegment,
  type EffectiveAddressTerms,
  type OperandBinding
} from "#core/instruction/bindings.js";
import { defaultSegmentForBase } from "#core/segments.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import { decodeBytes, ok as decodeOk } from "#core/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import { x86StatusFlags } from "#core/flags/definitions.js";
import { decodeExit } from "#cpu/exit.js";
import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import { reg32, type MemOperand, type Reg32 } from "#core/types.js";
import {
  assertPageFaultException,
  readPageFaultStop,
  writePageFaultStop,
  type CpuExceptionStop
} from "#cpu/tests/stop-fixtures.js";
import {
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testFunctionCompleted, instantiateTestFunction } from "./harness.js";
import type { AluFlags } from "./reference.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const satisfies AluFlags;

// Memory cases with explicit state, guest bytes, and fault expectations.

// One wasm page, so the first out-of-bounds byte is at guestByteLength.
const guestByteLength = 0x10000;

test("mov r32, [ebx+disp] loads the guest cell", async () => {
  const instruction = decodeOk(decodeBytes([0x8b, 0x43, 0x04]));
  const initial: Partial<WasmCpuStateSnapshot> = { ebx: 0x20, eip: instruction.address, ...allFlagsSet };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x24, 0x1122_3344, true);

  strictEqual(run(), testFunctionCompleted);
  assertState(
    stateView,
    { regs: { eax: 0x1122_3344, ebx: 0x20 }, eip: instruction.nextEip, flags: allFlagsSet },
    "mov r32, [ebx+4]"
  );
});

test("mov [ebx+disp], r32 stores the guest cell", async () => {
  const instruction = decodeOk(decodeBytes([0x89, 0x43, 0x04]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xcafe_1234,
    ebx: 0x20,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint32(0x24, true), 0xcafe_1234);
  assertState(
    stateView,
    { regs: { eax: 0xcafe_1234, ebx: 0x20 }, eip: instruction.nextEip, flags: allFlagsSet },
    "mov [ebx+4], r32"
  );
});

test("mov moffs accumulator forms load and store at their widths", async () => {
  const instructions = decodeSequence([
    [0xa0, 0x20, 0x00, 0x00, 0x00],
    [0xa3, 0x38, 0x00, 0x00, 0x00],
    [0xa2, 0x30, 0x00, 0x00, 0x00],
    [0x66, 0xa1, 0x22, 0x00, 0x00, 0x00],
    [0xa3, 0x3c, 0x00, 0x00, 0x00],
    [0x66, 0xa3, 0x32, 0x00, 0x00, 0x00],
    [0xa1, 0x24, 0x00, 0x00, 0x00],
    [0xa3, 0x34, 0x00, 0x00, 0x00]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xaaaa_0000,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint8(0x20, 0x7f);
  guestView.setUint16(0x22, 0xbeef, true);
  guestView.setUint32(0x24, 0xc001_cafe, true);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint32(0x38, true), 0xaaaa_007f);
  strictEqual(guestView.getUint8(0x30), 0x7f);
  strictEqual(guestView.getUint32(0x3c, true), 0xaaaa_beef);
  strictEqual(guestView.getUint16(0x32, true), 0xbeef);
  strictEqual(guestView.getUint32(0x34, true), 0xc001_cafe);
  assertState(
    stateView,
    { regs: { eax: 0xc001_cafe }, eip: instructions[7]!.nextEip, flags: allFlagsSet },
    "mov moffs accumulator forms"
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
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 0x1122_33f6, true);

  strictEqual(run(), testFunctionCompleted);
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
  const { stateView, run } = await instantiateTestFunction(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), readPageFaultStop(guestByteLength), "read fault");
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

test("a direct-offset read fault reports the offset and leaves state unchanged", async () => {
  const instruction = decodeOk(decodeBytes([0xa1, 0xfe, 0xff, 0x00, 0x00]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0x1234_5678,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), readPageFaultStop(guestByteLength - 2), "moffs read fault");
  assertState(
    stateView,
    { regs: { eax: 0x1234_5678 }, eip: instruction.address, flags: allFlagsSet },
    "moffs read fault"
  );
});

test("a write fault leaves guest memory untouched", async () => {
  // mov [ebx], eax with the range crossing the guest end.
  const instruction = decodeOk(decodeBytes([0x89, 0x03]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xdead_beef,
    ebx: guestByteLength - 2,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), writePageFaultStop(guestByteLength - 2), "write fault");
  strictEqual(guestView.getUint32(guestByteLength - 4, true), 0);
  assertState(
    stateView,
    { regs: { eax: 0xdead_beef, ebx: guestByteLength - 2 }, eip: instruction.address, flags: allFlagsSet },
    "write fault"
  );
});

test("a direct-offset write fault reports the offset and leaves state unchanged", async () => {
  const instruction = decodeOk(decodeBytes([0xa3, 0xfe, 0xff, 0x00, 0x00]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xdead_beef,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), writePageFaultStop(guestByteLength - 2), "moffs write fault");
  strictEqual(guestView.getUint32(guestByteLength - 4, true), 0);
  assertState(
    stateView,
    { regs: { eax: 0xdead_beef }, eip: instruction.address, flags: allFlagsSet },
    "moffs write fault"
  );
});

test("a narrow access faults with its byte length", async () => {
  // movzx eax, byte [ebx] one past the guest.
  const instruction = decodeOk(decodeBytes([0x0f, 0xb6, 0x03]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: guestByteLength,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), readPageFaultStop(guestByteLength), "byte fault");
  assertState(
    stateView,
    { regs: { ebx: guestByteLength }, eip: instruction.address, flags: allFlagsSet },
    "byte fault"
  );
});

function blockOf(instructions: readonly IsaDecodedInstruction[]) {
  const builder = createInstructionFunction();

  for (const instruction of instructions) {
    builder.add(instruction.spec.semantics, bindingsFor(instruction), loc(instruction.address, instruction.nextEip));
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
        return regBinding(operand.alias.name);
      case "imm":
        return immBinding(operand.value);
      case "mem":
        return memBinding(
          effectiveAddressTermsOf(operand),
          staticMemSegment(operand.segment ?? defaultSegmentForBase(operand.base))
        );
      case "segment":
        throw new Error("segment operands not supported in the memory e2e");
      case "relTarget":
        throw new Error("relTarget operands not supported in the memory e2e");
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

function assertFaultExit(exit: bigint, expected: CpuExceptionStop, label: string): void {
  const decoded = decodeExit(exit);

  strictEqual(decoded.kind, "cpuException", `${label} kind`);
  if (decoded.kind !== "cpuException") {
    return;
  }

  strictEqual(decoded.exception.kind, expected.exception.kind, `${label} exception`);
  assertPageFaultException(decoded.exception, `${label} decoded page fault`);
  assertPageFaultException(expected.exception, `${label} expected page fault`);
  strictEqual(decoded.exception.linearAddress, expected.exception.linearAddress, `${label} linear address`);
  strictEqual(decoded.exception.errorCode, expected.exception.errorCode, `${label} error code`);
}

function assertState(
  stateView: DataView,
  expected: Readonly<{ regs: Partial<Record<Reg32, number>>; eip: number; flags: AluFlags }>,
  label: string
): void {
  for (const name of reg32) {
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel(name)), expected.regs[name] ?? 0, `${label} ${name}`);
  }

  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), expected.eip, `${label} eip`);

  for (const flag of x86StatusFlags) {
    strictEqual(readWasmCpuFlagByte(stateView, flag), expected.flags[flag], `${label} ${flag}`);
  }
}
