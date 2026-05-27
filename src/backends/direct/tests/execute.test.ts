import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { StopReason } from "#x86/execution/run-result.js";
import { ArrayBufferGuestMemory } from "#x86/memory/guest-memory.js";
import { createCpuState, getFlag, setFlag } from "#x86/state/cpu-state.js";
import { executeDirectInstruction } from "#backends/direct/execute.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { decodeBytes, ok, startAddress } from "./helpers.js";

test("executes mov r32, imm32", () => {
  const state = createCpuState({ eip: startAddress });
  const result = execute(state, [0xbb, 0x78, 0x56, 0x34, 0x12]);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.ebx, 0x1234_5678);
  strictEqual(state.eip, startAddress + 5);
  strictEqual(state.instructionCount, 1);
});

test("executes register mov in both ModRM directions", () => {
  const state = createCpuState({ eax: 0x1111_1111, ebx: 0x2222_2222, eip: startAddress });

  execute(state, [0x8b, 0xc3]);
  strictEqual(state.eax, 0x2222_2222);

  executeAtStateEip(state, [0x89, 0xc3]);
  strictEqual(state.ebx, 0x2222_2222);
  strictEqual(state.instructionCount, 2);
});

test("executes cmovcc register source without modifying flags", () => {
  const taken = createCpuState({ ecx: 0x2222_2222, edx: 0x1111_1111, eip: startAddress });
  const notTaken = createCpuState({ ecx: 0x2222_2222, edx: 0x1111_1111, eip: startAddress });

  setFlag(taken, "ZF", true);
  setFlag(notTaken, "ZF", false);

  execute(taken, [0x0f, 0x44, 0xd1]);
  execute(notTaken, [0x0f, 0x44, 0xd1]);

  strictEqual(taken.edx, 0x2222_2222);
  strictEqual(notTaken.edx, 0x1111_1111);
  strictEqual(getFlag(taken, "ZF"), true);
  strictEqual(getFlag(notTaken, "ZF"), false);
});

test("executes cmovcc r16 as a conditional partial register write", () => {
  const taken = createCpuState({ ecx: 0x3333_2222, edx: 0xaaaa_1111, eip: startAddress });
  const notTaken = createCpuState({ ecx: 0x3333_2222, edx: 0xaaaa_1111, eip: startAddress });

  setFlag(taken, "ZF", true);
  setFlag(notTaken, "ZF", false);

  execute(taken, [0x66, 0x0f, 0x44, 0xd1]);
  execute(notTaken, [0x66, 0x0f, 0x44, 0xd1]);

  strictEqual(taken.edx, 0xaaaa_2222);
  strictEqual(notTaken.edx, 0xaaaa_1111);
  strictEqual(getFlag(taken, "ZF"), true);
  strictEqual(getFlag(notTaken, "ZF"), false);
});

test("cmovcc memory source faults even when condition is false", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ ebx: 0x100, edx: 0x1111_1111, eip: startAddress });

  setFlag(state, "ZF", true);
  const result = execute(state, [0x0f, 0x45, 0x13], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x100);
  strictEqual(state.edx, 0x1111_1111);
  strictEqual(state.instructionCount, 0);
});

test("cmovcc r16 memory source faults even when condition is false", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ ebx: 0x100, edx: 0xaaaa_1111, eip: startAddress });

  setFlag(state, "ZF", true);
  const result = execute(state, [0x66, 0x0f, 0x45, 0x13], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x100);
  strictEqual(state.edx, 0xaaaa_1111);
  strictEqual(state.instructionCount, 0);
});

test("executes register-only setcc without modifying flags", () => {
  const flags = 0x8d5;
  const taken = createCpuState({ eax: 0x1234_5678, eflags: flags, eip: startAddress });
  const notTaken = createCpuState({ eax: 0x1234_5678, eflags: flags, eip: startAddress });
  const highByte = createCpuState({ eax: 0x1234_5678, eflags: flags, eip: startAddress });

  setFlag(taken, "ZF", true);
  setFlag(notTaken, "ZF", false);
  setFlag(highByte, "ZF", false);

  execute(taken, [0x0f, 0x94, 0xc0]);
  execute(notTaken, [0x0f, 0x94, 0xc0]);
  execute(highByte, [0x0f, 0x95, 0xc4]);

  strictEqual(taken.eax, 0x1234_5601);
  strictEqual(notTaken.eax, 0x1234_5600);
  strictEqual(highByte.eax, 0x1234_0178);
  strictEqual(getFlag(taken, "ZF"), true);
  strictEqual(getFlag(notTaken, "ZF"), false);
  strictEqual(getFlag(highByte, "ZF"), false);
});

test("executes memory setcc as a selected byte store", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const taken = createCpuState({ ebx: 0x20, eip: startAddress });
  const notTaken = createCpuState({ ebx: 0x21, eip: startAddress });

  setFlag(taken, "ZF", true);
  setFlag(notTaken, "ZF", false);

  deepStrictEqual(memory.writeU8(0x20, 0xaa), { ok: true });
  deepStrictEqual(memory.writeU8(0x21, 0xaa), { ok: true });
  execute(taken, [0x0f, 0x94, 0x03], memory);
  execute(notTaken, [0x0f, 0x94, 0x03], memory);

  deepStrictEqual(memory.readU8(0x20), { ok: true, value: 1 });
  deepStrictEqual(memory.readU8(0x21), { ok: true, value: 0 });
  strictEqual(getFlag(taken, "ZF"), true);
  strictEqual(getFlag(notTaken, "ZF"), false);
});

test("executes mov r/m32, imm32", () => {
  const state = createCpuState({ eax: 0, eip: startAddress });
  const result = execute(state, [0xc7, 0xc0, 0x78, 0x56, 0x34, 0x12]);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.eip, startAddress + 6);
  strictEqual(state.instructionCount, 1);
});

test("executes byte and word mov through register aliases", () => {
  const state = createCpuState({ eax: 0x1234_5678, eip: startAddress });

  execute(state, [0xb0, 0xaa]);
  strictEqual(state.eax, 0x1234_56aa);

  executeAtStateEip(state, [0xb4, 0xbb]);
  strictEqual(state.eax, 0x1234_bbaa);

  executeAtStateEip(state, [0x66, 0xb8, 0xcd, 0xab]);
  strictEqual(state.eax, 0x1234_abcd);
  strictEqual(state.instructionCount, 3);
});

test("executes register-only xchg after reading both operands", () => {
  const flags = 0x8d5;
  const dword = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    eflags: flags,
    eip: startAddress
  });
  const byte = createCpuState({
    eax: 0x1234_5678,
    ebx: 0xaabb_ccdd,
    eflags: flags,
    eip: startAddress
  });
  const word = createCpuState({
    eax: 0x1234_5678,
    ebx: 0xaabb_ccdd,
    eflags: flags,
    eip: startAddress
  });
  const highByte = createCpuState({
    eax: 0x1234_5678,
    eflags: flags,
    eip: startAddress
  });

  execute(dword, [0x87, 0xd8]);
  strictEqual(dword.eax, 0x2222_2222);
  strictEqual(dword.ebx, 0x1111_1111);
  strictEqual(dword.eflags, flags);

  execute(byte, [0x86, 0xd8]);
  strictEqual(byte.eax, 0x1234_56dd);
  strictEqual(byte.ebx, 0xaabb_cc78);
  strictEqual(byte.eflags, flags);

  execute(word, [0x66, 0x87, 0xd8]);
  strictEqual(word.eax, 0x1234_ccdd);
  strictEqual(word.ebx, 0xaabb_5678);
  strictEqual(word.eflags, flags);

  execute(highByte, [0x86, 0xe0]);
  strictEqual(highByte.eax, 0x1234_7856);
  strictEqual(highByte.eflags, flags);
});

test("executes same-register xchg as a flagless no-op", () => {
  const flags = 0x8d5;
  const state = createCpuState({
    eax: 0x1234_5678,
    ebx: 0xaabb_ccdd,
    eflags: flags,
    eip: startAddress
  });

  execute(state, [0x87, 0xc0]);
  executeAtStateEip(state, [0x66, 0x87, 0xc0]);
  executeAtStateEip(state, [0x86, 0xc0]);
  executeAtStateEip(state, [0x86, 0xe4]);

  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.ebx, 0xaabb_ccdd);
  strictEqual(state.eflags, flags);
  strictEqual(state.instructionCount, 4);
});

test("executes memory xchg after reading memory and register operands", () => {
  const flags = 0x8d5;
  const dwordMemory = new ArrayBufferGuestMemory(0x40);
  const byteMemory = new ArrayBufferGuestMemory(0x40);
  const wordMemory = new ArrayBufferGuestMemory(0x40);
  const dword = createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress });
  const byte = createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress });
  const word = createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: flags, eip: startAddress });

  deepStrictEqual(dwordMemory.writeU32(0x20, 0x1122_3344), { ok: true });
  execute(dword, [0x87, 0x18], dwordMemory);
  strictEqual(dword.eax, 0x20);
  strictEqual(dword.ebx, 0x1122_3344);
  strictEqual(dword.eflags, flags);
  deepStrictEqual(dwordMemory.readU32(0x20), { ok: true, value: 0xaabb_ccdd });

  deepStrictEqual(byteMemory.writeU8(0x20, 0x78), { ok: true });
  execute(byte, [0x86, 0x18], byteMemory);
  strictEqual(byte.eax, 0x20);
  strictEqual(byte.ebx, 0xaabb_cc78);
  strictEqual(byte.eflags, flags);
  deepStrictEqual(byteMemory.readU8(0x20), { ok: true, value: 0xdd });

  deepStrictEqual(wordMemory.writeU16(0x20, 0x1357), { ok: true });
  execute(word, [0x66, 0x87, 0x18], wordMemory);
  strictEqual(word.eax, 0x20);
  strictEqual(word.ebx, 0xaabb_1357);
  strictEqual(word.eflags, flags);
  deepStrictEqual(wordMemory.readU16(0x20), { ok: true, value: 0xccdd });
});

test("memory xchg read fault is atomic", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({
    eax: 0x40,
    ebx: 0x2222_2222,
    eflags: 0x8d5,
    eip: startAddress,
    instructionCount: 7
  });
  const result = execute(state, [0x87, 0x18], memory);

  strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
  strictEqual(result.faultAddress, 0x40);
  strictEqual(result.faultSize, 4);
  strictEqual(result.faultOperation, "read");
  strictEqual(state.eax, 0x40);
  strictEqual(state.ebx, 0x2222_2222);
  strictEqual(state.eflags, 0x8d5);
  strictEqual(state.eip, startAddress);
  strictEqual(state.instructionCount, 7);
});

test("executes movzx and movsx without modifying flags", () => {
  const flags = 0x8d5;
  const registerState = createCpuState({ eax: 0xaaaa_aaaa, ebx: 0x1234_807f, eflags: flags, eip: startAddress });

  execute(registerState, [0x0f, 0xb6, 0xc7]);
  strictEqual(registerState.eax, 0x80);
  strictEqual(registerState.eflags, flags);

  executeAtStateEip(registerState, [0x0f, 0xbe, 0xcf]);
  strictEqual(registerState.ecx, 0xffff_ff80);
  strictEqual(registerState.eflags, flags);

  const zeroExtendWordDestination = createCpuState({ eax: 0x1234_0000, ebx: 0x80, eflags: flags, eip: startAddress });
  execute(zeroExtendWordDestination, [0x66, 0x0f, 0xb6, 0xc3]);
  strictEqual(zeroExtendWordDestination.eax, 0x1234_0080);
  strictEqual(zeroExtendWordDestination.eflags, flags);

  const wordDestinationState = createCpuState({ eax: 0x1234_0000, ebx: 0x80, eflags: flags, eip: startAddress });
  execute(wordDestinationState, [0x66, 0x0f, 0xbe, 0xc3]);
  strictEqual(wordDestinationState.eax, 0x1234_ff80);
  strictEqual(wordDestinationState.eflags, flags);

  const memory = new ArrayBufferGuestMemory(0x40);
  memory.writeU16(0x20, 0x80ff);

  const zeroExtendState = createCpuState({ eax: 0xffff_ffff, ebx: 0x20, eflags: flags, eip: startAddress });
  execute(zeroExtendState, [0x0f, 0xb7, 0x03], memory);
  strictEqual(zeroExtendState.eax, 0x80ff);
  strictEqual(zeroExtendState.eflags, flags);

  memory.writeU8(0x20, 0xfe);
  const zeroExtendByteState = createCpuState({ eax: 0xffff_ffff, ebx: 0x20, eflags: flags, eip: startAddress });
  execute(zeroExtendByteState, [0x0f, 0xb6, 0x03], memory);
  strictEqual(zeroExtendByteState.eax, 0xfe);
  strictEqual(zeroExtendByteState.eflags, flags);

  memory.writeU8(0x20, 0x80);
  const signExtendByteState = createCpuState({ eax: 0, ebx: 0x20, eflags: flags, eip: startAddress });
  execute(signExtendByteState, [0x0f, 0xbe, 0x03], memory);
  strictEqual(signExtendByteState.eax, 0xffff_ff80);
  strictEqual(signExtendByteState.eflags, flags);

  memory.writeU16(0x20, 0x8001);
  const signExtendState = createCpuState({ eax: 0, ebx: 0x20, eflags: flags, eip: startAddress });
  execute(signExtendState, [0x0f, 0xbf, 0x03], memory);
  strictEqual(signExtendState.eax, 0xffff_8001);
  strictEqual(signExtendState.eflags, flags);
});

test("executes movsx r16 from byte register before bl/bx/ebx alias operations", () => {
  const state = createCpuState({ eax: 0x80, ebx: 0x1122_3344, eip: startAddress });

  execute(state, [0x66, 0x0f, 0xbe, 0xd8]);
  executeAtStateEip(state, [0x80, 0xc3, 0x01]);
  executeAtStateEip(state, [0x66, 0x83, 0xc3, 0x01]);
  executeAtStateEip(state, [0x83, 0xc3, 0x01]);

  strictEqual(state.eax, 0x80);
  strictEqual(state.ebx, 0x1122_ff83);
  strictEqual(state.eip, startAddress + 14);
  strictEqual(state.instructionCount, 4);
});

test("executes movsx from a word register copy", () => {
  const state = createCpuState({
    eax: 0x1234_0000,
    ebx: 0x0000_8001,
    ecx: 0xcccc_cccc,
    eflags: 0x8d5,
    eip: startAddress
  });

  execute(state, [0x66, 0x89, 0xd8]);
  executeAtStateEip(state, [0x0f, 0xbf, 0xc8]);

  strictEqual(state.eax, 0x1234_8001);
  strictEqual(state.ebx, 0x0000_8001);
  strictEqual(state.ecx, 0xffff_8001);
  strictEqual(state.eflags, 0x8d5);
  strictEqual(state.eip, startAddress + 6);
  strictEqual(state.instructionCount, 2);
});

test("executes add r/m32, r32 and materializes add flags", () => {
  const state = createCpuState({ eax: 0xffff_ffff, ebx: 1, eip: startAddress });

  execute(state, [0x01, 0xd8]);

  strictEqual(state.eax, 0);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "SF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("executes add eax, imm32", () => {
  const state = createCpuState({ eax: 0x7fff_ffff, eip: startAddress });

  execute(state, [0x05, 0x01, 0x00, 0x00, 0x00]);

  strictEqual(state.eax, 0x8000_0000);
  strictEqual(getFlag(state, "OF"), true);
  strictEqual(getFlag(state, "SF"), true);
});

test("executes or eax, imm32 and materializes logic flags", () => {
  const state = createCpuState({ eax: 0x8000_0000, eflags: 0xffff_ffff, eip: startAddress });

  execute(state, [0x0d, 0x01, 0x00, 0x00, 0x00]);

  strictEqual(state.eax, 0x8000_0001);
  strictEqual(getFlag(state, "SF"), true);
  strictEqual(getFlag(state, "ZF"), false);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
  strictEqual(getFlag(state, "AF"), false);
});

test("executes and r/m32, sign-extended imm8 and materializes logic flags", () => {
  const state = createCpuState({ eax: 0xffff_ffff, eip: startAddress });

  execute(state, [0x83, 0xe0, 0x00]);

  strictEqual(state.eax, 0);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("executes sub r/m32, sign-extended imm8", () => {
  const state = createCpuState({ ebx: 0, eip: startAddress });

  execute(state, [0x83, 0xeb, 0xff]);

  strictEqual(state.ebx, 1);
  strictEqual(getFlag(state, "CF"), true);
});

test("executes xor eax, imm32 and clears logical carry/overflow", () => {
  const state = createCpuState({ eax: 0xffff_ffff, eflags: 0xffff_ffff, eip: startAddress });

  execute(state, [0x35, 0xff, 0xff, 0xff, 0xff]);

  strictEqual(state.eax, 0);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
  strictEqual(getFlag(state, "AF"), false);
});

test("executes cmp without writing operands", () => {
  const state = createCpuState({ eax: 5, ebx: 5, eip: startAddress });

  execute(state, [0x39, 0xd8]);

  strictEqual(state.eax, 5);
  strictEqual(state.ebx, 5);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "CF"), false);
});

test("executes test without writing operands", () => {
  const state = createCpuState({ eax: 0x80, ebx: 0xff, eip: startAddress });

  execute(state, [0x85, 0xd8]);

  strictEqual(state.eax, 0x80);
  strictEqual(state.ebx, 0xff);
  strictEqual(getFlag(state, "ZF"), false);
  strictEqual(getFlag(state, "SF"), false);
  strictEqual(getFlag(state, "CF"), false);
});

test("executes memory mov load and store", () => {
  const memory = new ArrayBufferGuestMemory(0x40);
  const state = createCpuState({ eax: 0xaabb_ccdd, ebx: 0x10, eip: startAddress });

  execute(state, [0x89, 0x43, 0x04], memory);
  deepStrictEqual(memory.readU32(0x14), { ok: true, value: 0xaabb_ccdd });

  state.eax = 0;
  executeAtStateEip(state, [0x8b, 0x43, 0x04], memory);
  strictEqual(state.eax, 0xaabb_ccdd);
});

test("executes lea without reading memory", () => {
  const state = createCpuState({ ebx: 0x20, eip: startAddress });

  execute(state, [0x8d, 0x43, 0x04]);

  strictEqual(state.eax, 0x24);
});

test("executes lea base index scale displacement", () => {
  const state = createCpuState({ ebx: 0x100, ecx: 3, eip: startAddress });
  const result = execute(state, [0x8d, 0x44, 0x8b, 0x10]);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.eax, 0x11c);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.instructionCount, 1);
});

test("executes lea with no base and disp32", () => {
  const state = createCpuState({ ecx: 3, eip: startAddress });
  const result = execute(state, [0x8d, 0x04, 0x8d, 0x00, 0x20, 0x40, 0x00]);

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.eax, 0x0040_200c);
});

test("lea does not modify flags", () => {
  const flags = 0x8d5;
  const state = createCpuState({ ebx: 0x100, ecx: 3, eflags: flags, eip: startAddress });

  execute(state, [0x8d, 0x44, 0x8b, 0x10]);

  strictEqual(state.eflags, flags);
});

test("executes lea r16 and preserves high register bits and flags", () => {
  const flags = 0x8d5;
  const state = createCpuState({ eax: 0x1234_0000, ebx: 0x100, ecx: 3, eflags: flags, eip: startAddress });

  execute(state, [0x66, 0x8d, 0x44, 0x8b, 0x10]);

  strictEqual(state.eax, 0x1234_011c);
  strictEqual(state.eflags, flags);
});

test("executes multi-byte nop without reading memory or modifying flags", () => {
  const flags = 0x8d5;
  const state = createCpuState({ eax: 0x1_0000, eflags: flags, eip: startAddress });

  execute(state, [0x0f, 0x1f, 0x40, 0x00]);
  strictEqual(state.eip, startAddress + 4);
  strictEqual(state.eflags, flags);

  executeAtStateEip(state, [0x66, 0x0f, 0x1f, 0x00]);
  strictEqual(state.eip, startAddress + 8);
  strictEqual(state.eflags, flags);
  strictEqual(state.instructionCount, 2);
});

test("executes direct jumps", () => {
  const state = createCpuState({ eip: startAddress });

  execute(state, [0xeb, 0x05]);
  strictEqual(state.eip, startAddress + 7);

  executeAtAddress(state, startAddress, [0xe9, 0xfb, 0xff, 0xff, 0xff]);
  strictEqual(state.eip, startAddress);
});

test("executes conditional jump taken and not taken", () => {
  const notTaken = createCpuState({ eip: startAddress });
  const taken = createCpuState({ eip: startAddress });

  setFlag(notTaken, "ZF", true);
  execute(notTaken, [0x75, 0x05]);
  strictEqual(notTaken.eip, startAddress + 2);

  execute(taken, [0x83, 0xe8, 0x01]);
  executeAtStateEip(taken, [0x75, 0x05]);
  strictEqual(taken.eip, startAddress + 10);
});

test("executes int imm8 as a host trap", () => {
  const state = createCpuState({ eip: startAddress });
  const result = execute(state, [0xcd, 0x2e]);

  strictEqual(result.stopReason, StopReason.HOST_TRAP);
  strictEqual(result.trapVector, 0x2e);
  strictEqual(state.eip, startAddress + 2);
  strictEqual(state.instructionCount, 1);
  strictEqual(state.stopReason, StopReason.HOST_TRAP);
});

test("direct backend executes successful memory guards", () => {
  const state = createCpuState({ eip: startAddress });
  const instruction: IsaDecodedInstruction = {
    spec: {
      id: "test.memory_guard_noop",
      mnemonic: "test",
      opcode: [],
      format: { syntax: "test" },
      semantics: (s) => {
        s.memoryGuard(s.const32(0x1000), 4, "read");
        s.set(s.reg("eax"), 1);
      }
    },
    address: startAddress,
    length: 1,
    nextEip: startAddress + 1,
    operands: [],
    raw: []
  };
  const result = executeDirectInstruction(state, instruction, {
    memory: new ArrayBufferGuestMemory(0x2000)
  });

  strictEqual(result.stopReason, StopReason.NONE);
  strictEqual(state.eax, 1);
  strictEqual(state.eip, startAddress + 1);
  strictEqual(state.instructionCount, 1);
});

test("direct backend compares 8-bit and 16-bit signed values as signed JS numbers", () => {
  for (const testCase of [
    { width: 8, value: 0xff, expected: 1 },
    { width: 16, value: 0xffff, expected: 1 }
  ] as const) {
    const state = createCpuState({ ebx: testCase.value, eip: startAddress });
    const instruction: IsaDecodedInstruction = {
      spec: {
        id: "test.signed_compare",
        mnemonic: "test",
        opcode: [],
        format: { syntax: "test" },
        semantics: (s) => {
          const value = s.get(s.reg("ebx"), testCase.width);

          s.set(s.reg("eax"), s.compare(testCase.width, "lt_s", value, 0));
        }
      },
      address: startAddress,
      length: 1,
      nextEip: startAddress + 1,
      operands: [],
      raw: []
    };
    const result = executeDirectInstruction(state, instruction);

    strictEqual(result.stopReason, StopReason.NONE);
    strictEqual(state.eax, testCase.expected);
  }
});

function execute(state: ReturnType<typeof createCpuState>, values: readonly number[], memory?: ArrayBufferGuestMemory) {
  return executeAtAddress(state, startAddress, values, memory);
}

function executeAtStateEip(state: ReturnType<typeof createCpuState>, values: readonly number[], memory?: ArrayBufferGuestMemory) {
  return executeAtAddress(state, state.eip, values, memory);
}

function executeAtAddress(
  state: ReturnType<typeof createCpuState>,
  address: number,
  values: readonly number[],
  memory?: ArrayBufferGuestMemory
) {
  const decoded = ok(decodeBytes(values, address));

  state.eip = address;
  return memory === undefined
    ? executeDirectInstruction(state, decoded)
    : executeDirectInstruction(state, decoded, { memory });
}
