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
import { decodeBytes, ok as decodeOk, startAddress } from "#core/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import { x86Flags, x86StatusFlags, type X86Flag } from "#core/flags/definitions.js";
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
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testFunctionCompleted, instantiateTestFunction } from "./harness.js";
import { aluReference, type AluFlags } from "./reference.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const satisfies AluFlags;
const noFlagsSet = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const satisfies AluFlags;
const pushfdFlagMasks = {
  CF: 1 << 0,
  PF: 1 << 2,
  AF: 1 << 4,
  ZF: 1 << 6,
  SF: 1 << 7,
  TF: 1 << 8,
  DF: 1 << 10,
  OF: 1 << 11,
  NT: 1 << 14,
  AC: 1 << 18,
  ID: 1 << 21
} as const satisfies Readonly<Record<X86Flag, number>>;

const allPushfdFlagsSet = Object.fromEntries(
  Object.keys(pushfdFlagMasks).map((flag) => [flag, 1])
) as Readonly<Record<X86Flag, number>>;

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

test("add [mem], r32 read-modify-writes the cell with reference flags", async () => {
  // add [eax], ebx with a wrap to zero: CF and ZF both come out set.
  const instruction = decodeOk(decodeBytes([0x01, 0x18]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0x20,
    ebx: 0xffff_ffff,
    eip: instruction.address
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 1, true);

  // dest = [eax] (1), src = ebx (0xffffffff): the cell wraps to zero.
  const reference = aluReference("add", 32, 1, 0xffff_ffff);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint32(0x20, true), reference.result);
  assertState(
    stateView,
    { regs: { eax: 0x20, ebx: 0xffff_ffff }, eip: instruction.nextEip, flags: noFlagsSet },
    "add [eax], ebx"
  );
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 1, b: 0xffff_ffff }, "add [eax], ebx");
});

test("add r32, [mem] loads the operand with reference flags", async () => {
  const instruction = decodeOk(decodeBytes([0x03, 0x18]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0x20,
    ebx: 0x7fff_ffff,
    eip: instruction.address
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 1, true);

  // dest = ebx (0x7fffffff), src = [eax] (1): overflows signed, so SF and OF.
  const reference = aluReference("add", 32, 0x7fff_ffff, 1);

  strictEqual(run(), testFunctionCompleted);
  assertState(
    stateView,
    { regs: { eax: 0x20, ebx: reference.result }, eip: instruction.nextEip, flags: noFlagsSet },
    "add ebx, [eax]"
  );
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 0x7fff_ffff, b: 1 }, "add ebx, [eax]");
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

test("word push/pop forms use 16-bit stack cells with 32-bit ESP", async () => {
  const instructions = decodeSequence([
    [0x66, 0x50],
    [0x66, 0x59]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xaaaa_beef,
    ecx: 0x1111_2222,
    esp: 0x40,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint16(0x3e, true), 0xbeef);
  assertState(
    stateView,
    {
      regs: { eax: 0xaaaa_beef, ecx: 0x1111_beef, esp: 0x40 },
      eip: instructions[1]!.nextEip,
      flags: allFlagsSet
    },
    "word push/pop"
  );
});

test("operand-size push immediates write word stack cells", async () => {
  const instructions = decodeSequence([
    [0x66, 0x68, 0x34, 0x12],
    [0x66, 0x6a, 0xff]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    eip: instructions[0]!.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint16(0x3e, true), 0x1234);
  strictEqual(guestView.getUint16(0x3c, true), 0xffff);
  assertState(
    stateView,
    { regs: { esp: 0x3c }, eip: instructions[1]!.nextEip, flags: allFlagsSet },
    "word push immediates"
  );
});

test("word push memory source writes a 16-bit stack cell", async () => {
  const instruction = decodeOk(decodeBytes([0x66, 0xff, 0x33]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: 0x20,
    esp: 0x40,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint16(0x20, 0xbeef, true);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint16(0x3e, true), 0xbeef);
  assertState(
    stateView,
    { regs: { ebx: 0x20, esp: 0x3e }, eip: instruction.nextEip, flags: allFlagsSet },
    "word push [mem]"
  );
});

test("word pop memory destination computes the address after incrementing ESP", async () => {
  const instruction = decodeOk(decodeBytes([0x66, 0x8f, 0x04, 0x24]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint16(0x40, 0xbeef, true);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint16(0x42, true), 0xbeef);
  assertState(
    stateView,
    { regs: { esp: 0x42 }, eip: instruction.nextEip, flags: allFlagsSet },
    "word pop [esp]"
  );
});

test("a faulting word push reports a word-sized stack write", async () => {
  const instruction = decodeOk(decodeBytes([0x66, 0x50]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0x1234,
    esp: 1,
    eip: instruction.address,
    ...allFlagsSet
  };
  const { stateView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), writePageFaultStop(0xffff_ffff), "word push fault");
  assertState(
    stateView,
    { regs: { eax: 0x1234, esp: 1 }, eip: instruction.address, flags: allFlagsSet },
    "word push fault"
  );
});

test("pushad stores all dword registers and original ESP", async () => {
  const instruction = decodeOk(decodeBytes([0x60]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0x1111_1111,
    ecx: 0x2222_2222,
    edx: 0x3333_3333,
    ebx: 0x4444_4444,
    esp: 0x40,
    ebp: 0x5555_5555,
    esi: 0x6666_6666,
    edi: 0x7777_7777,
    eip: instruction.address,
    ...allPushfdFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint32(0x20, true), 0x7777_7777);
  strictEqual(guestView.getUint32(0x24, true), 0x6666_6666);
  strictEqual(guestView.getUint32(0x28, true), 0x5555_5555);
  strictEqual(guestView.getUint32(0x2c, true), 0x40);
  strictEqual(guestView.getUint32(0x30, true), 0x4444_4444);
  strictEqual(guestView.getUint32(0x34, true), 0x3333_3333);
  strictEqual(guestView.getUint32(0x38, true), 0x2222_2222);
  strictEqual(guestView.getUint32(0x3c, true), 0x1111_1111);
  assertState(
    stateView,
    {
      regs: {
        eax: 0x1111_1111,
        ecx: 0x2222_2222,
        edx: 0x3333_3333,
        ebx: 0x4444_4444,
        esp: 0x20,
        ebp: 0x5555_5555,
        esi: 0x6666_6666,
        edi: 0x7777_7777
      },
      eip: instruction.nextEip,
      flags: allFlagsSet
    },
    "pushad"
  );
  assertStoredFlags(stateView, allPushfdFlagsSet, "pushad");
});

test("pusha stores all word registers and original SP", async () => {
  const instruction = decodeOk(decodeBytes([0x66, 0x60]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xaaaa_1111,
    ecx: 0xbbbb_2222,
    edx: 0xcccc_3333,
    ebx: 0xdddd_4444,
    esp: 0x40,
    ebp: 0xeeee_5555,
    esi: 0xffff_6666,
    edi: 0x9999_7777,
    eip: instruction.address,
    ...allPushfdFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint16(0x30, true), 0x7777);
  strictEqual(guestView.getUint16(0x32, true), 0x6666);
  strictEqual(guestView.getUint16(0x34, true), 0x5555);
  strictEqual(guestView.getUint16(0x36, true), 0x0040);
  strictEqual(guestView.getUint16(0x38, true), 0x4444);
  strictEqual(guestView.getUint16(0x3a, true), 0x3333);
  strictEqual(guestView.getUint16(0x3c, true), 0x2222);
  strictEqual(guestView.getUint16(0x3e, true), 0x1111);
  assertState(
    stateView,
    {
      regs: {
        eax: 0xaaaa_1111,
        ecx: 0xbbbb_2222,
        edx: 0xcccc_3333,
        ebx: 0xdddd_4444,
        esp: 0x30,
        ebp: 0xeeee_5555,
        esi: 0xffff_6666,
        edi: 0x9999_7777
      },
      eip: instruction.nextEip,
      flags: allFlagsSet
    },
    "pusha"
  );
  assertStoredFlags(stateView, allPushfdFlagsSet, "pusha");
});

test("popad restores dword registers and skips saved ESP", async () => {
  const instruction = decodeOk(decodeBytes([0x61]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x20,
    eip: instruction.address,
    ...allPushfdFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 0x7777_7777, true);
  guestView.setUint32(0x24, 0x6666_6666, true);
  guestView.setUint32(0x28, 0x5555_5555, true);
  guestView.setUint32(0x2c, 0xdead_beef, true);
  guestView.setUint32(0x30, 0x4444_4444, true);
  guestView.setUint32(0x34, 0x3333_3333, true);
  guestView.setUint32(0x38, 0x2222_2222, true);
  guestView.setUint32(0x3c, 0x1111_1111, true);

  strictEqual(run(), testFunctionCompleted);
  assertState(
    stateView,
    {
      regs: {
        eax: 0x1111_1111,
        ecx: 0x2222_2222,
        edx: 0x3333_3333,
        ebx: 0x4444_4444,
        esp: 0x40,
        ebp: 0x5555_5555,
        esi: 0x6666_6666,
        edi: 0x7777_7777
      },
      eip: instruction.nextEip,
      flags: allFlagsSet
    },
    "popad"
  );
  assertStoredFlags(stateView, allPushfdFlagsSet, "popad");
});

test("popa restores word registers and skips saved SP", async () => {
  const instruction = decodeOk(decodeBytes([0x66, 0x61]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xaaaa_0000,
    ecx: 0xbbbb_0000,
    edx: 0xcccc_0000,
    ebx: 0xdddd_0000,
    esp: 0x30,
    ebp: 0xeeee_0000,
    esi: 0xffff_0000,
    edi: 0x9999_0000,
    eip: instruction.address,
    ...allPushfdFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint16(0x30, 0x7777, true);
  guestView.setUint16(0x32, 0x6666, true);
  guestView.setUint16(0x34, 0x5555, true);
  guestView.setUint16(0x36, 0xbeef, true);
  guestView.setUint16(0x38, 0x4444, true);
  guestView.setUint16(0x3a, 0x3333, true);
  guestView.setUint16(0x3c, 0x2222, true);
  guestView.setUint16(0x3e, 0x1111, true);

  strictEqual(run(), testFunctionCompleted);
  assertState(
    stateView,
    {
      regs: {
        eax: 0xaaaa_1111,
        ecx: 0xbbbb_2222,
        edx: 0xcccc_3333,
        ebx: 0xdddd_4444,
        esp: 0x40,
        ebp: 0xeeee_5555,
        esi: 0xffff_6666,
        edi: 0x9999_7777
      },
      eip: instruction.nextEip,
      flags: allFlagsSet
    },
    "popa"
  );
  assertStoredFlags(stateView, allPushfdFlagsSet, "popa");
});

test("stack-all range guards report full dword and word ranges", async () => {
  for (const [name, bytes, initial, expectedExit] of [
    [
      "pushad",
      [0x60],
      { eax: 0x1111_1111, esp: 0x10, eip: startAddress, ...allFlagsSet },
      writePageFaultStop(0xffff_fff0)
    ],
    [
      "popad",
      [0x61],
      { eax: 0x1111_1111, esp: guestByteLength - 16, eip: startAddress, ...allFlagsSet },
      readPageFaultStop(guestByteLength - 16)
    ],
    [
      "pusha",
      [0x66, 0x60],
      { eax: 0x1111_1111, esp: 8, eip: startAddress, ...allFlagsSet },
      writePageFaultStop(0xffff_fff8)
    ],
    [
      "popa",
      [0x66, 0x61],
      { eax: 0x1111_1111, esp: guestByteLength - 8, eip: startAddress, ...allFlagsSet },
      readPageFaultStop(guestByteLength - 8)
    ]
  ] as const) {
    const instruction = decodeOk(decodeBytes(bytes));
    const { stateView, run } = await instantiateTestFunction(blockOf([instruction]));

    writeWasmCpuStateSnapshot(stateView, initial);

    assertFaultExit(run(), expectedExit, name);
    assertState(
      stateView,
      { regs: { eax: 0x1111_1111, esp: initial.esp }, eip: instruction.address, flags: allFlagsSet },
      name
    );
  }
});

test("pushfd stores the usermode eflags image", async () => {
  const instruction = decodeOk(decodeBytes([0x9c]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    eip: instruction.address,
    ...allPushfdFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint32(0x3c, true), expectedPushfdImage(allPushfdFlagsSet));
  assertState(
    stateView,
    { regs: { esp: 0x3c }, eip: instruction.nextEip, flags: allFlagsSet },
    "pushfd"
  );
});

test("pushfd stores the fixed usermode image when no state flags are set", async () => {
  const instruction = decodeOk(decodeBytes([0x9c]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    eip: instruction.address
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint32(0x3c, true), 0x202);
  assertState(
    stateView,
    { regs: { esp: 0x3c }, eip: instruction.nextEip, flags: noFlagsSet },
    "pushfd fixed image"
  );
});

test("pushf stores the low usermode flags image", async () => {
  const instruction = decodeOk(decodeBytes([0x66, 0x9c]));
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    eip: instruction.address,
    ...allPushfdFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint16(0x3e, true), expectedPushfdImage(allPushfdFlagsSet) & 0xffff);
  assertState(
    stateView,
    { regs: { esp: 0x3e }, eip: instruction.nextEip, flags: allFlagsSet },
    "pushf"
  );
});

test("popfd distributes stored flags and ignores privileged bits", async () => {
  const instruction = decodeOk(decodeBytes([0x9d]));
  const privilegedBits = (1 << 9) | (3 << 12) | (1 << 16) | (1 << 17) | (1 << 19) | (1 << 20);
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    eip: instruction.address,
    ...allPushfdFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x40, privilegedBits, true);

  strictEqual(run(), testFunctionCompleted);
  assertState(
    stateView,
    { regs: { esp: 0x44 }, eip: instruction.nextEip, flags: noFlagsSet },
    "popfd"
  );
  assertStoredFlags(stateView, storedFlagsFromImage(0), "popfd");
});

test("popf distributes low flags and preserves AC/ID", async () => {
  const instruction = decodeOk(decodeBytes([0x66, 0x9d]));
  const privilegedBits = (1 << 9) | (3 << 12);
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    eip: instruction.address,
    ...allPushfdFlagsSet
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint16(0x40, privilegedBits, true);

  strictEqual(run(), testFunctionCompleted);
  assertState(
    stateView,
    { regs: { esp: 0x42 }, eip: instruction.nextEip, flags: noFlagsSet },
    "popf"
  );
  assertStoredFlags(stateView, { ...storedFlagsFromImage(0), AC: 1, ID: 1 }, "popf");
});

test("popfd/pushfd round-trips stored flags", async () => {
  const instructions = decodeSequence([
    [0x9d],
    [0x9c]
  ]);
  const image = expectedPushfdImage({ CF: 1, AF: 1, DF: 1, AC: 1, ID: 1 }) | (1 << 9) | (3 << 12) | (1 << 16);
  const expectedImage = expectedPushfdImage(storedFlagsFromImage(image));
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    eip: instructions[0]!.address
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x40, image, true);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint32(0x40, true), expectedImage);
  assertState(
    stateView,
    {
      regs: { esp: 0x40 },
      eip: instructions[1]!.nextEip,
      flags: {
        CF: 1,
        PF: 0,
        AF: 1,
        ZF: 0,
        SF: 0,
        OF: 0
      }
    },
    "popfd/pushfd"
  );
  assertStoredFlags(stateView, storedFlagsFromImage(image), "popfd/pushfd");
});

test("popf/pushf round-trips low flags while preserving AC/ID", async () => {
  const instructions = decodeSequence([
    [0x66, 0x9d],
    [0x66, 0x9c]
  ]);
  const image = expectedPushfdImage({ CF: 1, AF: 1, DF: 1, NT: 1 }) | (1 << 9) | (3 << 12);
  const expectedImage = expectedPushfdImage(storedFlagsFromImage(image)) & 0xffff;
  const initial: Partial<WasmCpuStateSnapshot> = {
    esp: 0x40,
    AC: 1,
    ID: 1,
    eip: instructions[0]!.address
  };
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint16(0x40, image, true);

  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint16(0x40, true), expectedImage);
  assertState(
    stateView,
    {
      regs: { esp: 0x40 },
      eip: instructions[1]!.nextEip,
      flags: {
        CF: 1,
        PF: 0,
        AF: 1,
        ZF: 0,
        SF: 0,
        OF: 0
      }
    },
    "popf/pushf"
  );
  assertStoredFlags(stateView, { ...storedFlagsFromImage(image), AC: 1, ID: 1 }, "popf/pushf");
});

test("popfd makes AC and ID toggle detection stick", async () => {
  for (const [name, bit] of [["AC", pushfdFlagMasks.AC], ["ID", pushfdFlagMasks.ID]] as const) {
    const instructions = decodeSequence([
      [0x9c],
      [0x81, 0x34, 0x24, bit & 0xff, (bit >>> 8) & 0xff, (bit >>> 16) & 0xff, (bit >>> 24) & 0xff],
      [0x9d],
      [0x9c],
      [0x58]
    ]);
    const initial: Partial<WasmCpuStateSnapshot> = {
      esp: 0x40,
      eip: instructions[0]!.address
    };
    const { stateView, run } = await instantiateTestFunction(blockOf(instructions));

    writeWasmCpuStateSnapshot(stateView, initial);

    strictEqual(run(), testFunctionCompleted);
    assertState(
      stateView,
      {
        regs: { eax: 0x202 | bit, esp: 0x40 },
        eip: instructions[4]!.nextEip,
        flags: noFlagsSet
      },
      name
    );
    strictEqual(readWasmCpuFlagByte(stateView, name), 1, name);
  }
});

test("a faulting pushfd write reports its eip with prior state flushed", async () => {
  // add eax, 1; pushfd with esp too close to zero for a dword stack write.
  const instructions = decodeSequence([
    [0x83, 0xc0, 0x01],
    [0x9c]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xffff_ffff,
    esp: 2,
    eip: instructions[0]!.address
  };
  const { stateView, run } = await instantiateTestFunction(blockOf(instructions));
  const reference = aluReference("add", 32, 0xffff_ffff, 1);

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), writePageFaultStop(0xffff_fffe), "pushfd fault");
  assertState(
    stateView,
    { regs: { eax: reference.result, esp: 2 }, eip: instructions[1]!.address, flags: noFlagsSet },
    "pushfd fault"
  );
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 }, "pushfd fault");
});

test("a faulting popfd read reports its eip with prior state flushed", async () => {
  // add eax, 1; popfd with esp too close to the guest end for a dword stack read.
  const instructions = decodeSequence([
    [0x83, 0xc0, 0x01],
    [0x9d]
  ]);
  const initial: Partial<WasmCpuStateSnapshot> = {
    eax: 0xffff_ffff,
    esp: guestByteLength - 2,
    eip: instructions[0]!.address
  };
  const { stateView, run } = await instantiateTestFunction(blockOf(instructions));
  const reference = aluReference("add", 32, 0xffff_ffff, 1);

  writeWasmCpuStateSnapshot(stateView, initial);

  assertFaultExit(run(), readPageFaultStop(guestByteLength - 2), "popfd fault");
  assertState(
    stateView,
    { regs: { eax: reference.result, esp: guestByteLength - 2 }, eip: instructions[1]!.address, flags: noFlagsSet },
    "popfd fault"
  );
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 }, "popfd fault");
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
  const { stateView, guestView, run } = await instantiateTestFunction(blockOf(instructions));

  writeWasmCpuStateSnapshot(stateView, initial);
  guestView.setUint32(0x20, 0xcafe_1234, true);

  // The add commits esp = 0x20 and its flags before the pop faults.
  const reference = aluReference("add", 32, 0x1c, 4);

  assertFaultExit(run(), writePageFaultStop(guestByteLength - 2), "pop [mem] fault");
  strictEqual(guestView.getUint32(0x20, true), 0xcafe_1234);
  assertState(
    stateView,
    { regs: { esp: reference.result, ebx: guestByteLength - 2 }, eip: instructions[1]!.address, flags: allFlagsSet },
    "pop [mem] fault"
  );
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 0x1c, b: 4 }, "pop [mem] fault");
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

function expectedPushfdImage(flags: Partial<Record<X86Flag, number>>): number {
  let image = 0x202;

  for (const flag of Object.keys(pushfdFlagMasks) as X86Flag[]) {
    if (flags[flag] !== undefined && flags[flag] !== 0) {
      image |= pushfdFlagMasks[flag];
    }
  }

  return image >>> 0;
}

function storedFlagsFromImage(image: number): Readonly<Record<X86Flag, number>> {
  return Object.fromEntries(
    x86Flags.map((flag) => [flag, (image & pushfdFlagMasks[flag]) === 0 ? 0 : 1])
  ) as Readonly<Record<X86Flag, number>>;
}

function assertStoredFlags(
  stateView: DataView,
  expected: Readonly<Record<X86Flag, number>>,
  label: string
): void {
  for (const flag of x86Flags) {
    strictEqual(readWasmCpuFlagByte(stateView, flag), expected[flag], `${label} ${flag}`);
  }
}
