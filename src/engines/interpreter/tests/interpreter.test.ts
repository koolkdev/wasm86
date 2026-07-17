import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#ir/slots.js";
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
  instantiateInterpreterCompiledModule,
  type InterpreterModuleInstance
} from "#engines/interpreter/tests/interpreter-helpers.js";
import {
  encodeInterpreterModule,
  type InterpreterModule
} from "#engines/interpreter/module.js";

// End-to-end coverage of the interpreter module: guest programs over the
// dispatch loop, decode faults, and the one-handler-per-op+width shape.

const startAddress = 0x1000;
// Any byte outside the ISA stops the run.
const haltByte = 0xf4;

let encoded: InterpreterModule | undefined;
let compiled: WebAssembly.Module | undefined;

function encodedModule(): InterpreterModule {
  encoded ??= encodeInterpreterModule();
  return encoded;
}

async function instantiate(): Promise<InterpreterModuleInstance> {
  compiled ??= new WebAssembly.Module(encodedModule().bytes);
  return instantiateInterpreterCompiledModule(compiled);
}

function writeProgram(view: DataView, address: number, bytes: readonly number[]): void {
  for (const [index, byte] of bytes.entries()) {
    view.setUint8(address + index, byte);
  }
}

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

test("a program mixing mov, ALU, cmp, and jcc runs to its halt byte", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0xb9, 0x05, 0x00, 0x00, 0x00, // mov ecx, 5
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0x01, 0xc8,                   // add eax, ecx
    0x83, 0xe9, 0x01,             // sub ecx, 1
    0x75, 0xf9,                   // jne -7 (back to the add)
    haltByte
  ]);

  const exit = interpreter.run(100);

  deepStrictEqual(exit, { kind: "unsupported", reason: "unsupportedOpcode" });
  strictEqual(readRegister(interpreter.stateView, "eax"), 15);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x11);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 17);
  assertLazyFlagState(interpreter.stateView, { kind: "SUB", width: 32, a: 1, b: 1 });
});

test("cmp against an immediate steers a two-byte jcc when taken", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eax: 7, eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0x3d, 0x07, 0x00, 0x00, 0x00,       // cmp eax, 7
    0x0f, 0x84, 0x01, 0x00, 0x00, 0x00, // je +1
    haltByte,                           // skipped when taken
    0xb8, 0x2a, 0x00, 0x00, 0x00,       // mov eax, 42
    haltByte
  ]);

  const exit = interpreter.run(100);

  deepStrictEqual(exit, { kind: "unsupported", reason: "unsupportedOpcode" });
  strictEqual(readRegister(interpreter.stateView, "eax"), 42);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x11);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 3);
  assertLazyFlagState(interpreter.stateView, { kind: "SUB", width: 32, a: 7, b: 7 });
});

test("a not-taken jcc falls through to the next instruction", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eax: 8, eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0x3d, 0x07, 0x00, 0x00, 0x00,       // cmp eax, 7
    0x0f, 0x84, 0x01, 0x00, 0x00, 0x00, // je +1
    haltByte
  ]);

  const exit = interpreter.run(100);

  deepStrictEqual(exit, { kind: "unsupported", reason: "unsupportedOpcode" });
  strictEqual(readRegister(interpreter.stateView, "eax"), 8);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x0b);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 2);
  assertLazyFlagState(interpreter.stateView, { kind: "SUB", width: 32, a: 8, b: 7 });
});

test("memory operands round-trip through the ModRM addressing forms", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, {
    ebx: 0x2000,
    esi: 0x30,
    ecx: 0x11223344,
    eip: startAddress
  });
  interpreter.guestView.setUint32(0x2060, 0x100, true);
  interpreter.guestView.setUint32(0x3000, 0xcafebabe, true);
  writeProgram(interpreter.guestView, startAddress, [
    0x89, 0x4b, 0x04,                   // mov [ebx+4], ecx
    0x8b, 0x53, 0x04,                   // mov edx, [ebx+4]
    0x03, 0x14, 0x73,                   // add edx, [ebx+esi*2]
    0x8b, 0x0d, 0x00, 0x30, 0x00, 0x00, // mov ecx, [0x3000]
    0x88, 0x0b,                         // mov [ebx], cl
    0x8a, 0x73, 0x04,                   // mov dh, [ebx+4]
    haltByte
  ]);

  const exit = interpreter.run(100);

  deepStrictEqual(exit, { kind: "unsupported", reason: "unsupportedOpcode" });
  strictEqual(interpreter.guestView.getUint32(0x2004, true), 0x11223344);
  strictEqual(interpreter.guestView.getUint8(0x2000), 0xbe);
  strictEqual(readRegister(interpreter.stateView, "edx"), 0x11224444);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0xcafebabe);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x14);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 6);
});

test("SIB addressing covers scaled-index, base-displacement, and no-index forms", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, {
    eax: 2,
    ebp: 0x3000,
    esp: 0x2800,
    eip: startAddress
  });
  interpreter.guestView.setUint32(0x3004, 0x1111, true);
  interpreter.guestView.setUint32(0x2004, 0x2222, true);
  interpreter.guestView.setUint32(0x2800, 0x3333, true);
  writeProgram(interpreter.guestView, startAddress, [
    0x8b, 0x54, 0x85, 0xfc,                   // mov edx, [ebp+eax*4-4]
    0x8b, 0x0c, 0x45, 0x00, 0x20, 0x00, 0x00, // mov ecx, [eax*2+0x2000]
    0x8b, 0x1c, 0x24,                         // mov ebx, [esp]
    haltByte
  ]);

  const exit = interpreter.run(100);

  deepStrictEqual(exit, { kind: "unsupported", reason: "unsupportedOpcode" });
  strictEqual(readRegister(interpreter.stateView, "edx"), 0x1111);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0x2222);
  strictEqual(readRegister(interpreter.stateView, "ebx"), 0x3333);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 0x0e);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 3);
});

test("byte-register forms touch only their byte of the register file", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eax: 0x11223344, ebx: 0, eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0x00, 0xc4,       // add ah, al  -> ah = 0x33 + 0x44
    0x88, 0xe3,       // mov bl, ah
    0x80, 0xc4, 0x90, // add ah, 0x90 -> wraps with carry
    haltByte
  ]);

  const exit = interpreter.run(100);

  deepStrictEqual(exit, { kind: "unsupported", reason: "unsupportedOpcode" });
  strictEqual(readRegister(interpreter.stateView, "eax"), 0x11220744);
  strictEqual(readRegister(interpreter.stateView, "ebx"), 0x77);
  assertLazyFlagState(interpreter.stateView, { kind: "ADD", width: 8, a: 0x77, b: 0x90 });
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 3);
});

test("test writes flags without touching its operands", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eax: 0xf0, eip: startAddress, ZF: 0 });
  writeProgram(interpreter.guestView, startAddress, [
    0xa8, 0x0f, // test al, 0x0f
    haltByte
  ]);

  const exit = interpreter.run(100);

  deepStrictEqual(exit, { kind: "unsupported", reason: "unsupportedOpcode" });
  strictEqual(readRegister(interpreter.stateView, "eax"), 0xf0);
  strictEqual(readWasmCpuFlagByte(interpreter.stateView, "ZF"), 0);
  assertLazyFlagState(interpreter.stateView, { kind: "LOGIC_RESULT", width: 8, a: 0 });
});

test("exhausted fuel exits with the instruction limit and the count preserved", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip: startAddress, instructionCount: 7 });
  writeProgram(interpreter.guestView, startAddress, [
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
    0xb9, 0x02, 0x00, 0x00, 0x00  // mov ecx, 2
  ]);

  const exit = interpreter.run(1);

  deepStrictEqual(exit, { kind: "instructionLimit" });
  strictEqual(readRegister(interpreter.stateView, "eax"), 1);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 5);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 8);
});

// A fused rep is one dispatch: the fuel budget no longer preempts it per
// element, so a run may overshoot its budget mid-rep while the count stays
// exact per unit.
test("rep movsd runs every unit in one dispatch past the fuel budget", async () => {
  const interpreter = await instantiate();

  writeWasmCpuStateSnapshot(interpreter.stateView, {
    ecx: 3,
    esi: 0x2000,
    edi: 0x3000,
    eip: startAddress
  });
  writeProgram(interpreter.guestView, startAddress, [
    0xf3, 0xa5, // rep movsd
    0xcd, 0x2e
  ]);
  interpreter.guestView.setUint32(0x2000, 0x1111_2222, true);
  interpreter.guestView.setUint32(0x2004, 0x3333_4444, true);
  interpreter.guestView.setUint32(0x2008, 0x5555_6666, true);

  const exhausted = interpreter.run(1);

  deepStrictEqual(exhausted, { kind: "instructionLimit" });
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0);
  strictEqual(readRegister(interpreter.stateView, "esi"), 0x200c);
  strictEqual(readRegister(interpreter.stateView, "edi"), 0x300c);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 2);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 3);
  strictEqual(interpreter.guestView.getUint32(0x3000, true), 0x1111_2222);
  strictEqual(interpreter.guestView.getUint32(0x3004, true), 0x3333_4444);
  strictEqual(interpreter.guestView.getUint32(0x3008, true), 0x5555_6666);

  const completed = interpreter.run(10);

  deepStrictEqual(completed, { kind: "hostTrap", vector: 0x2e });
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress + 4);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 4);
});

test("fetching the opcode past mapped memory is a decode fault at the boundary", async () => {
  const interpreter = await instantiate();
  const eip = guestMemoryMinimumByteLength;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });

  const exit = interpreter.run(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("the temporary flat model keeps its fetch boundary after guest memory grows", async () => {
  const interpreter = await instantiate();
  const boundary = guestMemoryMinimumByteLength;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip: boundary });

  deepStrictEqual(interpreter.run(10), fetchPageFaultStop(boundary));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), boundary);

  interpreter.guestMemory.grow(1);
  writeProgram(new DataView(interpreter.guestMemory.buffer), boundary, [0xcd, 0x2e]);

  deepStrictEqual(interpreter.run(10), fetchPageFaultStop(boundary));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), boundary);
});

test("an immediate crossing the end of memory faults with the instruction's eip", async () => {
  const interpreter = await instantiate();
  const eip = guestMemoryMinimumByteLength - 2;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });
  writeProgram(interpreter.guestView, eip, [0xb8, 0x99]); // mov eax, imm32 cut short

  const exit = interpreter.run(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 1));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("a displacement crossing the end of memory is a decode fault", async () => {
  const interpreter = await instantiate();
  const eip = guestMemoryMinimumByteLength - 5;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });
  writeProgram(interpreter.guestView, eip, [0x8b, 0x05, 0x00, 0x20, 0x00]); // mov eax, [disp32] cut short

  const exit = interpreter.run(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 2));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
});

test("a SIB byte past the end of memory is a decode fault at its address", async () => {
  const interpreter = await instantiate();
  const eip = guestMemoryMinimumByteLength - 2;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });
  writeProgram(interpreter.guestView, eip, [0x8b, 0x04]); // mov eax, [sib...] cut short

  const exit = interpreter.run(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 2));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("a SIB displacement crossing the end of memory is a decode fault", async () => {
  const interpreter = await instantiate();
  const eip = guestMemoryMinimumByteLength - 5;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip });
  writeProgram(interpreter.guestView, eip, [0x8b, 0x04, 0x45, 0x00, 0x20]); // mov eax, [eax*2+disp32] cut short

  const exit = interpreter.run(10);

  deepStrictEqual(exit, fetchPageFaultStop(eip + 3));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("a guest load past the end is a memory fault, not a decode fault", async () => {
  const interpreter = await instantiate();
  const address = guestMemoryMinimumByteLength - 3;

  writeWasmCpuStateSnapshot(interpreter.stateView, { eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0x8b, 0x05,
    address & 0xff,
    (address >> 8) & 0xff,
    (address >> 16) & 0xff,
    (address >> 24) & 0xff // mov eax, [end - 3]
  ]);

  const exit = interpreter.run(10);

  deepStrictEqual(exit, readPageFaultStop(address));
  strictEqual(readWasmCpuStateField(interpreter.stateView, "eip"), startAddress);
  strictEqual(readWasmCpuStateField(interpreter.stateView, "instructionCount"), 0);
});

test("one handler body per ALU op, width, and addressing form", () => {
  const counts = new Map<string, number>();

  for (const handler of encodedModule().handlers) {
    if (!handler.instructionId.startsWith("add.")) {
      continue;
    }

    const key = `${handler.instructionId}/${handler.form}`;

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const modRmForms = ["regDynamic", "memStatic", "memDynamic"] as const;
  const expected: [string, number][] = [
    ["add.al_imm8/plain", 1],
    ["add.ax_imm16/plain", 1],
    ["add.eax_imm32/plain", 1],
    ...[
      "add.r16_rm16",
      "add.r32_rm32",
      "add.r8_rm8",
      "add.rm16_imm16",
      "add.rm16_imm8",
      "add.rm16_r16",
      "add.rm32_imm32",
      "add.rm32_imm8",
      "add.rm32_r32",
      "add.rm8_imm8",
      "add.rm8_r8"
    ].flatMap((id): [string, number][] => modRmForms.map((form) => [`${id}/${form}`, 1]))
  ];

  deepStrictEqual([...counts.entries()].sort(), expected.sort());
});

test("every ModRM memory arm shares one rm-decode helper per opcode length", () => {
  const memoryHandlers = encodedModule().handlers.filter(
    (handler) => handler.form === "memStatic" || handler.form === "memDynamic"
  );

  ok(memoryHandlers.length > 1, "expected several ModRM memory arms");
  // One helper per byte count before the ModRM: plain and two-byte opcodes.
  // Prefixed encodings reuse both through the rebased eip local.
  deepStrictEqual([...encodedModule().rmDecodeHelpers].sort(), [1, 2]);
});

test("ModRM handlers never repeat per register", () => {
  const seen = new Set<string>();

  for (const handler of encodedModule().handlers) {
    if (handler.form === "plain") {
      continue;
    }

    const key = `${handler.instructionId}/${handler.form}`;

    strictEqual(seen.has(key), false, `duplicate handler body for ${key}`);
    seen.add(key);
  }
});
