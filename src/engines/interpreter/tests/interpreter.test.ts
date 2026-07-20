import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#core/state/channels.js";
import { invalidOpcode } from "#core/exceptions.js";
import type { RegName } from "#core/types.js";
import { fetchPageFaultStop, readPageFaultStop } from "#cpu/tests/stop-fixtures.js";
import {
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  readWasmCpuStateField,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import {
  instantiateInterpreter,
  writeGuestBytes
} from "./harness.js";

// End-to-end coverage of the interpreter module: guest programs over the
// dispatch loop and typed instruction-fetch faults.

const startAddress = 0x1000;
// Any byte outside the configured ISA raises #UD and stops the run.
const undefinedByte = 0xf4;

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

test("a program mixing mov, ALU, cmp, and jcc commits before a trailing #UD", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip: startAddress });
  writeGuestBytes(interpreter.guestView, startAddress, [
    0xb9, 0x05, 0x00, 0x00, 0x00, // mov ecx, 5
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0x01, 0xc8,                   // add eax, ecx
    0x83, 0xe9, 0x01,             // sub ecx, 1
    0x75, 0xf9,                   // jne -7 (back to the add)
    undefinedByte
  ]);

  const exit = interpreter.runFor(100);

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  strictEqual(readRegister(interpreter.stateView, "eax"), 15);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x11);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 17);
  assertLazyFlagState(interpreter.stateView, { kind: "SUB", width: 32, a: 1, b: 1 });
});

test("cmp against an immediate steers a two-byte jcc when taken", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eax: 7, eip: startAddress });
  writeGuestBytes(interpreter.guestView, startAddress, [
    0x3d, 0x07, 0x00, 0x00, 0x00,       // cmp eax, 7
    0x0f, 0x84, 0x01, 0x00, 0x00, 0x00, // je +1
    undefinedByte,                       // skipped when taken
    0xb8, 0x2a, 0x00, 0x00, 0x00,       // mov eax, 42
    undefinedByte
  ]);

  const exit = interpreter.runFor(100);

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  strictEqual(readRegister(interpreter.stateView, "eax"), 42);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x11);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 3);
  assertLazyFlagState(interpreter.stateView, { kind: "SUB", width: 32, a: 7, b: 7 });
});

test("a not-taken jcc falls through to the next instruction", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eax: 8, eip: startAddress });
  writeGuestBytes(interpreter.guestView, startAddress, [
    0x3d, 0x07, 0x00, 0x00, 0x00,       // cmp eax, 7
    0x0f, 0x84, 0x01, 0x00, 0x00, 0x00, // je +1
    undefinedByte
  ]);

  const exit = interpreter.runFor(100);

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  strictEqual(readRegister(interpreter.stateView, "eax"), 8);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x0b);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 2);
  assertLazyFlagState(interpreter.stateView, { kind: "SUB", width: 32, a: 8, b: 7 });
});

test("memory operands round-trip through the ModRM addressing forms", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, {
    ebx: 0x2000,
    esi: 0x30,
    ecx: 0x11223344,
    eip: startAddress
  });
  interpreter.guestView.setUint32(0x2060, 0x100, true);
  interpreter.guestView.setUint32(0x3000, 0xcafebabe, true);
  writeGuestBytes(interpreter.guestView, startAddress, [
    0x89, 0x4b, 0x04,                   // mov [ebx+4], ecx
    0x8b, 0x53, 0x04,                   // mov edx, [ebx+4]
    0x03, 0x14, 0x73,                   // add edx, [ebx+esi*2]
    0x8b, 0x0d, 0x00, 0x30, 0x00, 0x00, // mov ecx, [0x3000]
    0x88, 0x0b,                         // mov [ebx], cl
    0x8a, 0x73, 0x04,                   // mov dh, [ebx+4]
    undefinedByte
  ]);

  const exit = interpreter.runFor(100);

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  strictEqual(interpreter.guestView.getUint32(0x2004, true), 0x11223344);
  strictEqual(interpreter.guestView.getUint8(0x2000), 0xbe);
  strictEqual(readRegister(interpreter.stateView, "edx"), 0x11224444);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0xcafebabe);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x14);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 6);
});

test("SIB addressing covers scaled-index, base-displacement, and no-index forms", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, {
    eax: 2,
    ebp: 0x3000,
    esp: 0x2800,
    eip: startAddress
  });
  interpreter.guestView.setUint32(0x3004, 0x1111, true);
  interpreter.guestView.setUint32(0x2004, 0x2222, true);
  interpreter.guestView.setUint32(0x2800, 0x3333, true);
  writeGuestBytes(interpreter.guestView, startAddress, [
    0x8b, 0x54, 0x85, 0xfc,                   // mov edx, [ebp+eax*4-4]
    0x8b, 0x0c, 0x45, 0x00, 0x20, 0x00, 0x00, // mov ecx, [eax*2+0x2000]
    0x8b, 0x1c, 0x24,                         // mov ebx, [esp]
    undefinedByte
  ]);

  const exit = interpreter.runFor(100);

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  strictEqual(readRegister(interpreter.stateView, "edx"), 0x1111);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0x2222);
  strictEqual(readRegister(interpreter.stateView, "ebx"), 0x3333);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x0e);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 3);
});

test("byte-register forms touch only their byte of the register file", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eax: 0x11223344, ebx: 0, eip: startAddress });
  writeGuestBytes(interpreter.guestView, startAddress, [
    0x00, 0xc4,       // add ah, al  -> ah = 0x33 + 0x44
    0x88, 0xe3,       // mov bl, ah
    0x80, 0xc4, 0x90, // add ah, 0x90 -> wraps with carry
    undefinedByte
  ]);

  const exit = interpreter.runFor(100);

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  strictEqual(readRegister(interpreter.stateView, "eax"), 0x11220744);
  strictEqual(readRegister(interpreter.stateView, "ebx"), 0x77);
  assertLazyFlagState(interpreter.stateView, { kind: "ADD", width: 8, a: 0x77, b: 0x90 });
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 3);
});

test("test writes flags without touching its operands", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eax: 0xf0, eip: startAddress, ZF: 0 });
  writeGuestBytes(interpreter.guestView, startAddress, [
    0xa8, 0x0f, // test al, 0x0f
    undefinedByte
  ]);

  const exit = interpreter.runFor(100);

  deepStrictEqual(exit, { kind: "cpuException", exception: invalidOpcode() });
  strictEqual(readRegister(interpreter.stateView, "eax"), 0xf0);
  strictEqual(readWasmCpuFlagByte(interpreter.stateView, "ZF"), 0);
  assertLazyFlagState(interpreter.stateView, { kind: "LOGIC_RESULT", width: 8, a: 0 });
});

test("an exhausted instruction budget exits at the limit with the count preserved", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip: startAddress, instructionCount: 7 });
  writeGuestBytes(interpreter.guestView, startAddress, [
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
    0xb9, 0x02, 0x00, 0x00, 0x00  // mov ecx, 2
  ]);

  const exit = interpreter.runFor(1);

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(readRegister(interpreter.stateView, "eax"), 1);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 5);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 8);
});

// A fused rep is one dispatch: the instruction budget no longer preempts it per
// element, so a run may overshoot its budget mid-rep while the count stays
// exact per unit.
test("rep movsd runs every unit past a wrapping instruction deadline", async () => {
  const interpreter = await instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, {
    ecx: 3,
    esi: 0x2000,
    edi: 0x3000,
    eip: startAddress,
    instructionCount: 0xffff_fffe
  });
  writeGuestBytes(interpreter.guestView, startAddress, [
    0xf3, 0xa5, // rep movsd
    0xcd, 0x2e
  ]);
  interpreter.guestView.setUint32(0x2000, 0x1111_2222, true);
  interpreter.guestView.setUint32(0x2004, 0x3333_4444, true);
  interpreter.guestView.setUint32(0x2008, 0x5555_6666, true);

  const exhausted = interpreter.runFor(1);

  deepStrictEqual(exhausted, { kind: "instructionLimit" });
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0);
  strictEqual(readRegister(interpreter.stateView, "esi"), 0x200c);
  strictEqual(readRegister(interpreter.stateView, "edi"), 0x300c);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 2);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 1);
  strictEqual(interpreter.guestView.getUint32(0x3000, true), 0x1111_2222);
  strictEqual(interpreter.guestView.getUint32(0x3004, true), 0x3333_4444);
  strictEqual(interpreter.guestView.getUint32(0x3008, true), 0x5555_6666);

  const completed = interpreter.runFor(10);

  deepStrictEqual(completed, { kind: "hostTrap", vector: 0x2e });
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 4);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 2);
});

test("fetching the opcode past mapped memory raises #PF at the boundary", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = guestMemoryMinimumByteLength;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });

  const exit = interpreter.runFor(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("the flat memory model keeps its fetch boundary after backing memory grows", async () => {
  const interpreter = await instantiateInterpreter();
  const boundary = guestMemoryMinimumByteLength;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip: boundary });

  deepStrictEqual(interpreter.runFor(10), fetchPageFaultStop(boundary));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), boundary);

  interpreter.guestMemory.grow(1);
  writeGuestBytes(new DataView(interpreter.guestMemory.buffer), boundary, [0xcd, 0x2e]);

  deepStrictEqual(interpreter.runFor(10), fetchPageFaultStop(boundary));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), boundary);
});

test("an immediate crossing the end of memory raises #PF at the first unavailable byte", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = guestMemoryMinimumByteLength - 2;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });
  writeGuestBytes(interpreter.guestView, eip, [0xb8, 0x99]); // mov eax, imm32 cut short

  const exit = interpreter.runFor(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 2));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("a displacement crossing the end of memory raises #PF at the first unavailable byte", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = guestMemoryMinimumByteLength - 5;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });
  writeGuestBytes(interpreter.guestView, eip, [0x8b, 0x05, 0x00, 0x20, 0x00]); // mov eax, [disp32] cut short

  const exit = interpreter.runFor(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 5));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
});

test("a SIB byte past the end of memory raises #PF at its address", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = guestMemoryMinimumByteLength - 2;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });
  writeGuestBytes(interpreter.guestView, eip, [0x8b, 0x04]); // mov eax, [sib...] cut short

  const exit = interpreter.runFor(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 2));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("a SIB displacement crossing the end of memory raises #PF at the first unavailable byte", async () => {
  const interpreter = await instantiateInterpreter();
  const eip = guestMemoryMinimumByteLength - 5;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });
  writeGuestBytes(interpreter.guestView, eip, [0x8b, 0x04, 0x45, 0x00, 0x20]); // mov eax, [eax*2+disp32] cut short

  const exit = interpreter.runFor(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 5));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("a guest data load past the end raises data-read #PF", async () => {
  const interpreter = await instantiateInterpreter();
  const address = guestMemoryMinimumByteLength - 3;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip: startAddress });
  writeGuestBytes(interpreter.guestView, startAddress, [
    0x8b, 0x05,
    address & 0xff,
    (address >> 8) & 0xff,
    (address >> 16) & 0xff,
    (address >> 24) & 0xff // mov eax, [end - 3]
  ]);

  const exit = interpreter.runFor(10);

  deepStrictEqual(exit, readPageFaultStop(address));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});
