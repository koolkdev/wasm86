import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { createLegacyInstructionBlock, type LegacyInstructionBlock } from "#engines/legacy-instruction-block.js";
import { immBinding, regBinding } from "#core/instruction/bindings.js";
import { gprChannel } from "#core/state/channels.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { RegName } from "#core/types.js";
import { coreStateFields } from "#core/state/layout.js";
import { cpuState } from "#cpu/state.js";
import { aluSemantic } from "#core/semantics/alu.js";
import { movSemantic, movsxSemantic, movzxSemantic } from "#core/semantics/mov.js";
import { xchgSemantic } from "#core/semantics/xchg.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  assertLazyFlagState,
  readWasmCpuStateChannel,
  readWasmCpuStateField,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { wasmBodyMemoryAccesses, wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { irBlockBody, irBlockCompleted, instantiateIrBlock } from "./harness.js";

const eaxStateOffset = cpuState.layout.array(coreStateFields.gprs).offset;

// The stage's end-to-end slice: semantics -> LegacyInstructionBlock -> emit ->
// instantiate -> run -> assert cpu state memory through the host view.

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

function assertCompleted(exit: bigint): void {
  strictEqual(exit, irBlockCompleted);
}

test("mov r32, imm32 sets the register bytes and eip and falls through", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x401000, 0x401005));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x12345678);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x401005);
});

test("mov r32, r32 copies the source register and leaves it intact", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0xcafe1234 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0xcafe1234);
  strictEqual(readRegister(stateView, "ebx"), 0xcafe1234);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x1002);
});

test("ordinary state writes leave lazy flag metadata untouched", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xcafe1234,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, 32),
    lazyFlagsA: 0x1111_2222,
    lazyFlagsB: 0x3333_4444
  });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xcafe1234);
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsKind"), lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, 32));
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsA"), 0x1111_2222);
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsB"), 0x3333_4444);
});

test("chained movs forward one read to both destinations", async () => {
  const builder = createLegacyInstructionBlock();
  const mov = movSemantic(32);

  builder.add(mov, [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.add(mov, [regBinding("ecx"), regBinding("ebx")], loc(0x1002, 0x1004));

  const block = builder.finish();

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0xdeadbeef });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xdeadbeef);
  strictEqual(readRegister(stateView, "ecx"), 0xdeadbeef);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x1004);
});

test("xchg eax, ebx swaps the registers", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111111, ebx: 0x22222222 });
  assertCompleted(run());
  // The captured snapshot is load-bearing here: reloading ebx at its use
  // would observe the just-stored eax and leave both registers equal.
  strictEqual(readRegister(stateView, "eax"), 0x22222222);
  strictEqual(readRegister(stateView, "ebx"), 0x11111111);
});

test("xchg eax, eax emits no register-state Wasm access", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(xchgSemantic(32), [regBinding("eax"), regBinding("eax")], loc(0x1000, 0x1001));

  const block = builder.finish();
  const body = irBlockBody(block).bytes;

  deepStrictEqual(
    wasmBodyMemoryAccesses(body).filter(
      (access) =>
        access.memoryIndex === wasmMemoryIndex.cpuState &&
        access.offset === eaxStateOffset
    ),
    []
  );

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111111 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x11111111);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x1001);
});

test("a mov before the xchg observes the pre-swap value", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(32), [regBinding("ecx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.add(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1002, 0x1004));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111111, ebx: 0x22222222 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ecx"), 0x11111111);
  strictEqual(readRegister(stateView, "eax"), 0x22222222);
  strictEqual(readRegister(stateView, "ebx"), 0x11111111);
});

test("a byte write merges into the full register through cpu state memory", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(8), [regBinding("al"), immBinding(0x9a)], loc(0x1000, 0x1002));
  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1002, 0x1004));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234569a);
  strictEqual(readRegister(stateView, "ebx"), 0x1234569a);
});

test("a 16-bit immediate store leaves the upper register half intact", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(16), [regBinding("ax"), immBinding(0xbeef)], loc(0x1000, 0x1004));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234beef);
});

test("movzx r32, r8 zero-extends the high byte through an offset load", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movzxSemantic(8, 32), [regBinding("ebx"), regBinding("ah")], loc(0x1000, 0x1003));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x1234f678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xf6);
});

test("movsx r32, r8/r16 sign-extends through marked loads", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movsxSemantic(8, 32), [regBinding("ebx"), regBinding("ah")], loc(0x1000, 0x1003));
  builder.add(movsxSemantic(16, 32), [regBinding("ecx"), regBinding("ax")], loc(0x1003, 0x1006));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x1234f678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xfffffff6);
  strictEqual(readRegister(stateView, "ecx"), 0xfffff678);
});

test("add al, imm8 stays on the byte channel with byte-wide flags", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 8), [regBinding("al"), immBinding(0x70)], loc(0x1000, 0x1002));

  const block = builder.finish();

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x123456f0 });
  assertCompleted(run());
  // 0xf0 + 0x70 = 0x160: the byte wraps and carries out.
  strictEqual(readRegister(stateView, "eax"), 0x12345660);
  assertLazyFlagState(stateView, { kind: "ADD", width: 8, a: 0xf0, b: 0x70 });
});

test("add ax, imm16 stays on the word channel", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(aluSemantic("add", 16), [regBinding("ax"), immBinding(0x2001)], loc(0x1000, 0x1004));

  const block = builder.finish();

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x1234f00f });
  assertCompleted(run());
  // 0xf00f + 0x2001 = 0x11010: the word wraps and carries out.
  strictEqual(readRegister(stateView, "eax"), 0x12341010);
  assertLazyFlagState(stateView, { kind: "ADD", width: 16, a: 0xf00f, b: 0x2001 });
});

test("mov ah and mov al merge through memory for a final 32-bit read", async () => {
  const builder = createLegacyInstructionBlock();

  builder.add(movSemantic(8), [regBinding("ah"), immBinding(0xab)], loc(0x1000, 0x1002));
  builder.add(movSemantic(8), [regBinding("al"), immBinding(0xcd)], loc(0x1002, 0x1004));
  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1004, 0x1006));

  const block = builder.finish();

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234abcd);
  strictEqual(readRegister(stateView, "ebx"), 0x1234abcd);
});

test("zero compares encode as eqz", () => {
  const builder = createLegacyInstructionBlock();
  const logicConditionTemplate: SemanticTemplate = (s, v) => {
    const result = v.binary("xor", s.read(s.reg("eax"), { width: 32 }), v.const(5));

    s.writeStatusFlagsSource({ kind: "logic", width: 32, result });
    s.write(s.reg("ebx"), v.select(s.condition("E"), v.const(1), v.const(0)), { width: 32 });
  };

  builder.add(logicConditionTemplate, [], loc(0x1000, 0x1003));

  const body = irBlockBody(builder.finish()).bytes;
  const opcodes = wasmBodyOpcodes(body);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Eqz).length, 1);
  strictEqual(opcodes.includes(wasmOpcode.i32Eq), false);
});

test("a value used twice computes once and both uses observe it", async () => {
  // eax = ebx = eax + ebx: one shared add consumed by both stores.
  const sumIntoBoth: SemanticTemplate = (s, v) => {
    const sum = v.binary("add", s.read(s.operand(0), { width: 32 }), s.read(s.operand(1), { width: 32 }));

    s.write(s.operand(0), sum, { width: 32 });
    s.write(s.operand(1), sum, { width: 32 });
  };
  const builder: LegacyInstructionBlock = createLegacyInstructionBlock();

  builder.add(sumIntoBoth, [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const body = irBlockBody(block).bytes;

  // One add for the shared sum, one for the count advance.
  strictEqual(wasmBodyOpcodes(body).filter((opcode) => opcode === wasmOpcode.i32Add).length, 2);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 100, ebx: 28 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 128);
  strictEqual(readRegister(stateView, "ebx"), 128);
});
