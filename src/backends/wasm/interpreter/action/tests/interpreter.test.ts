import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#ir/action/slots.js";
import type { RegName } from "#x86/types.js";
import { ExitReason } from "#wasm/exit.js";
import {
  readWasmFlagByte,
  readWasmStateChannel,
  readWasmStateField,
  writeWasmCpuState
} from "#wasm/state-layout.js";
import { wasmGuestMemoryMinByteLength } from "#wasm/abi.js";
import {
  instantiateInterpreterCompiledModule,
  type InterpreterModuleInstance
} from "#backends/wasm/interpreter/tests/interpreter-helpers.js";
import {
  encodeActionInterpreterModule,
  type ActionInterpreterModule
} from "#backends/wasm/interpreter/action/module.js";

// End-to-end coverage of the action interpreter variant: guest programs over
// the wired families (mov, ALU, cmp/test, jcc), decode faults, and the
// one-handler-per-op+width shape.

const startAddress = 0x1000;
// Any byte outside the wired families stops the run.
const haltByte = 0xf4;

let encoded: ActionInterpreterModule | undefined;
let compiled: WebAssembly.Module | undefined;

function encodedModule(): ActionInterpreterModule {
  encoded ??= encodeActionInterpreterModule();
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
  return readWasmStateChannel(view, gprChannel(name));
}

test("a program mixing mov, ALU, cmp, and jcc runs to its halt byte", async () => {
  const interpreter = await instantiate();

  writeWasmCpuState(interpreter.stateView, { eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0xb9, 0x05, 0x00, 0x00, 0x00, // mov ecx, 5
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0x01, 0xc8,                   // add eax, ecx
    0x83, 0xe9, 0x01,             // sub ecx, 1
    0x75, 0xf9,                   // jne -7 (back to the add)
    haltByte
  ]);

  const exit = interpreter.run(100);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  strictEqual(readRegister(interpreter.stateView, "eax"), 15);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), startAddress + 0x11);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 17);
  strictEqual(readWasmFlagByte(interpreter.stateView, "ZF"), 1);
  strictEqual(readWasmFlagByte(interpreter.stateView, "CF"), 0);
});

test("cmp against an immediate steers a two-byte jcc when taken", async () => {
  const interpreter = await instantiate();

  writeWasmCpuState(interpreter.stateView, { eax: 7, eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0x3d, 0x07, 0x00, 0x00, 0x00,       // cmp eax, 7
    0x0f, 0x84, 0x01, 0x00, 0x00, 0x00, // je +1
    haltByte,                           // skipped when taken
    0xb8, 0x2a, 0x00, 0x00, 0x00,       // mov eax, 42
    haltByte
  ]);

  const exit = interpreter.run(100);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  strictEqual(readRegister(interpreter.stateView, "eax"), 42);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), startAddress + 0x11);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 3);
  strictEqual(readWasmFlagByte(interpreter.stateView, "ZF"), 1);
});

test("a not-taken jcc falls through to the next instruction", async () => {
  const interpreter = await instantiate();

  writeWasmCpuState(interpreter.stateView, { eax: 8, eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0x3d, 0x07, 0x00, 0x00, 0x00,       // cmp eax, 7
    0x0f, 0x84, 0x01, 0x00, 0x00, 0x00, // je +1
    haltByte
  ]);

  const exit = interpreter.run(100);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  strictEqual(readRegister(interpreter.stateView, "eax"), 8);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), startAddress + 0x0b);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 2);
  strictEqual(readWasmFlagByte(interpreter.stateView, "ZF"), 0);
});

test("memory operands round-trip through the ModRM addressing forms", async () => {
  const interpreter = await instantiate();

  writeWasmCpuState(interpreter.stateView, {
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

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  strictEqual(interpreter.guestView.getUint32(0x2004, true), 0x11223344);
  strictEqual(interpreter.guestView.getUint8(0x2000), 0xbe);
  strictEqual(readRegister(interpreter.stateView, "edx"), 0x11224444);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0xcafebabe);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), startAddress + 0x14);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 6);
});

test("SIB addressing covers scaled-index, base-displacement, and no-index forms", async () => {
  const interpreter = await instantiate();

  writeWasmCpuState(interpreter.stateView, {
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

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  strictEqual(readRegister(interpreter.stateView, "edx"), 0x1111);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0x2222);
  strictEqual(readRegister(interpreter.stateView, "ebx"), 0x3333);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), startAddress + 0x0e);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 3);
});

test("byte-register forms touch only their byte of the register file", async () => {
  const interpreter = await instantiate();

  writeWasmCpuState(interpreter.stateView, { eax: 0x11223344, ebx: 0, eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0x00, 0xc4,       // add ah, al  -> ah = 0x33 + 0x44
    0x88, 0xe3,       // mov bl, ah
    0x80, 0xc4, 0x90, // add ah, 0x90 -> wraps with carry
    haltByte
  ]);

  const exit = interpreter.run(100);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  strictEqual(readRegister(interpreter.stateView, "eax"), 0x11220744);
  strictEqual(readRegister(interpreter.stateView, "ebx"), 0x77);
  strictEqual(readWasmFlagByte(interpreter.stateView, "CF"), 1);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 3);
});

test("test writes flags without touching its operands", async () => {
  const interpreter = await instantiate();

  writeWasmCpuState(interpreter.stateView, { eax: 0xf0, eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0xa8, 0x0f, // test al, 0x0f
    haltByte
  ]);

  const exit = interpreter.run(100);

  strictEqual(exit.exitReason, ExitReason.UNSUPPORTED);
  strictEqual(readRegister(interpreter.stateView, "eax"), 0xf0);
  strictEqual(readWasmFlagByte(interpreter.stateView, "ZF"), 1);
});

test("exhausted fuel exits with the instruction limit and the count preserved", async () => {
  const interpreter = await instantiate();

  writeWasmCpuState(interpreter.stateView, { eip: startAddress, instructionCount: 7 });
  writeProgram(interpreter.guestView, startAddress, [
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
    0xb9, 0x02, 0x00, 0x00, 0x00  // mov ecx, 2
  ]);

  const exit = interpreter.run(1);

  strictEqual(exit.exitReason, ExitReason.INSTRUCTION_LIMIT);
  strictEqual(readRegister(interpreter.stateView, "eax"), 1);
  strictEqual(readRegister(interpreter.stateView, "ecx"), 0);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), startAddress + 5);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 8);
});

test("fetching the opcode past mapped memory is a decode fault at the boundary", async () => {
  const interpreter = await instantiate();
  const eip = wasmGuestMemoryMinByteLength;

  writeWasmCpuState(interpreter.stateView, { eip });

  const exit = interpreter.run(10);

  strictEqual(exit.exitReason, ExitReason.DECODE_FAULT);
  strictEqual(exit.payload, eip);
  strictEqual(exit.detail, 1);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 0);
});

test("an immediate crossing the end of memory faults with the instruction's eip", async () => {
  const interpreter = await instantiate();
  const eip = wasmGuestMemoryMinByteLength - 2;

  writeWasmCpuState(interpreter.stateView, { eip });
  writeProgram(interpreter.guestView, eip, [0xb8, 0x99]); // mov eax, imm32 cut short

  const exit = interpreter.run(10);

  strictEqual(exit.exitReason, ExitReason.DECODE_FAULT);
  strictEqual(exit.payload, eip + 1);
  strictEqual(exit.detail, 4);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), eip);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 0);
});

test("a displacement crossing the end of memory is a decode fault", async () => {
  const interpreter = await instantiate();
  const eip = wasmGuestMemoryMinByteLength - 5;

  writeWasmCpuState(interpreter.stateView, { eip });
  writeProgram(interpreter.guestView, eip, [0x8b, 0x05, 0x00, 0x20, 0x00]); // mov eax, [disp32] cut short

  const exit = interpreter.run(10);

  strictEqual(exit.exitReason, ExitReason.DECODE_FAULT);
  strictEqual(exit.payload, eip + 2);
  strictEqual(exit.detail, 4);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), eip);
});

test("a guest load past the end is a memory fault, not a decode fault", async () => {
  const interpreter = await instantiate();
  const address = wasmGuestMemoryMinByteLength - 3;

  writeWasmCpuState(interpreter.stateView, { eip: startAddress });
  writeProgram(interpreter.guestView, startAddress, [
    0x8b, 0x05,
    address & 0xff,
    (address >> 8) & 0xff,
    (address >> 16) & 0xff,
    (address >> 24) & 0xff // mov eax, [end - 3]
  ]);

  const exit = interpreter.run(10);

  strictEqual(exit.exitReason, ExitReason.MEMORY_READ_FAULT);
  strictEqual(exit.payload, address);
  strictEqual(exit.detail, 4);
  strictEqual(readWasmStateField(interpreter.stateView, "eip"), startAddress);
  strictEqual(readWasmStateField(interpreter.stateView, "instructionCount"), 0);
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

  deepStrictEqual(
    [...counts.entries()].sort(),
    [
      ["add.al_imm8/plain", 1],
      ["add.eax_imm32/plain", 1],
      ["add.r32_rm32/memory", 1],
      ["add.r32_rm32/register", 1],
      ["add.r8_rm8/memory", 1],
      ["add.r8_rm8/register", 1],
      ["add.rm32_imm32/memory", 1],
      ["add.rm32_imm32/register", 1],
      ["add.rm32_imm8/memory", 1],
      ["add.rm32_imm8/register", 1],
      ["add.rm32_r32/memory", 1],
      ["add.rm32_r32/register", 1],
      ["add.rm8_imm8/memory", 1],
      ["add.rm8_imm8/register", 1],
      ["add.rm8_r8/memory", 1],
      ["add.rm8_r8/register", 1]
    ]
  );
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
