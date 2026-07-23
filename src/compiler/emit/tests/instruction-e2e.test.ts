import { strictEqual } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import {
  createInstructionFunction,
  type InstructionFunctionBuilder
} from "./instruction-function.js";
import { immBinding, regBinding } from "#core/instruction/bindings.js";
import { gprChannel } from "#core/state/channels.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { RegName } from "#core/types.js";
import { coreStateFields } from "#core/state/layout.js";
import { movSemantic, movsxSemantic, movzxSemantic } from "#core/semantics/mov.js";
import { xchgSemantic } from "#core/semantics/xchg.js";
import {
  readWasmCpuStateChannel,
  readWasmCpuStateField,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  testFunctionCompleted,
  instantiateTestFunction
} from "./harness.js";

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

function assertCompleted(exit: bigint): void {
  strictEqual(exit, testFunctionCompleted);
}

test("mov r32, imm32 sets the register bytes and eip and falls through", async () => {
  const builder = createInstructionFunction();

  builder.add(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x401000, 0x401005));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x12345678);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x401005);
});

test("mov r32, r32 copies the source register and leaves it intact", async () => {
  const builder = createInstructionFunction();

  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0xcafe1234 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0xcafe1234);
  strictEqual(readRegister(stateView, "ebx"), 0xcafe1234);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x1002);
});

test("ordinary state writes leave lazy flag metadata untouched", async () => {
  const builder = createInstructionFunction();

  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xcafe1234,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, 32),
    lazyFlagsA: 0x1111_2222,
    lazyFlagsB: 0x3333_4444
  });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xcafe1234);
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsKind"), 0x09);
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsA"), 0x1111_2222);
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsB"), 0x3333_4444);
});

test("chained movs forward one read to both destinations", async () => {
  const builder = createInstructionFunction();
  const mov = movSemantic(32);

  builder.add(mov, [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.add(mov, [regBinding("ecx"), regBinding("ebx")], loc(0x1002, 0x1004));

  const block = builder.finish();

  const { stateView, run } = await instantiateTestFunction(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0xdeadbeef });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xdeadbeef);
  strictEqual(readRegister(stateView, "ecx"), 0xdeadbeef);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x1004);
});

test("xchg eax, eax leaves the register unchanged", async () => {
  const builder = createInstructionFunction();

  builder.add(xchgSemantic(32), [regBinding("eax"), regBinding("eax")], loc(0x1000, 0x1001));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111111 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x11111111);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x1001);
});

test("a mov before the xchg observes the pre-swap value", async () => {
  const builder = createInstructionFunction();

  builder.add(movSemantic(32), [regBinding("ecx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.add(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1002, 0x1004));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111111, ebx: 0x22222222 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ecx"), 0x11111111);
  strictEqual(readRegister(stateView, "eax"), 0x22222222);
  strictEqual(readRegister(stateView, "ebx"), 0x11111111);
});

test("a byte write merges into the full register through cpu state memory", async () => {
  const builder = createInstructionFunction();

  builder.add(movSemantic(8), [regBinding("al"), immBinding(0x9a)], loc(0x1000, 0x1002));
  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1002, 0x1004));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234569a);
  strictEqual(readRegister(stateView, "ebx"), 0x1234569a);
});

test("a 16-bit immediate store leaves the upper register half intact", async () => {
  const builder = createInstructionFunction();

  builder.add(movSemantic(16), [regBinding("ax"), immBinding(0xbeef)], loc(0x1000, 0x1004));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234beef);
});

test("movzx r32, r8 zero-extends the high byte through an offset load", async () => {
  const builder = createInstructionFunction();

  builder.add(movzxSemantic(8, 32), [regBinding("ebx"), regBinding("ah")], loc(0x1000, 0x1003));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x1234f678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xf6);
});

test("movsx r32, r8/r16 sign-extends through marked loads", async () => {
  const builder = createInstructionFunction();

  builder.add(movsxSemantic(8, 32), [regBinding("ebx"), regBinding("ah")], loc(0x1000, 0x1003));
  builder.add(movsxSemantic(16, 32), [regBinding("ecx"), regBinding("ax")], loc(0x1003, 0x1006));

  const { stateView, run } = await instantiateTestFunction(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x1234f678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xfffffff6);
  strictEqual(readRegister(stateView, "ecx"), 0xfffff678);
});

test("mov ah and mov al merge through memory for a final 32-bit read", async () => {
  const builder = createInstructionFunction();

  builder.add(movSemantic(8), [regBinding("ah"), immBinding(0xab)], loc(0x1000, 0x1002));
  builder.add(movSemantic(8), [regBinding("al"), immBinding(0xcd)], loc(0x1002, 0x1004));
  builder.add(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1004, 0x1006));

  const block = builder.finish();

  const { stateView, run } = await instantiateTestFunction(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234abcd);
  strictEqual(readRegister(stateView, "ebx"), 0x1234abcd);
});

test("a value used twice reaches both uses", async () => {
  // eax = ebx = eax + ebx: one shared add consumed by both stores.
  const sumIntoBoth: SemanticTemplate = (s, v) => {
    const sum = v.binary("add", s.read(s.operand(0), { width: 32 }), s.read(s.operand(1), { width: 32 }));

    s.write(s.operand(0), sum, { width: 32 });
    s.write(s.operand(1), sum, { width: 32 });
  };
  const builder: InstructionFunctionBuilder = createInstructionFunction();

  builder.add(sumIntoBoth, [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const { stateView, run } = await instantiateTestFunction(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 100, ebx: 28 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 128);
  strictEqual(readRegister(stateView, "ebx"), 128);
});
