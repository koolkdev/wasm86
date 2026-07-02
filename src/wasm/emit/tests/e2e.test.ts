import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc, type IrBlockBuilder } from "#ir/builder.js";
import { immBinding, regBinding } from "#ir/operands.js";
import {
  eipChannel,
  gprChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  type StateSlot
} from "#ir/slots.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import type { Action } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { fitsUnsigned, ValueTable } from "#ir/values.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import type { RegName } from "#x86/types.js";
import { aluSemantic } from "#x86/semantics/alu.js";
import { movSemantic, movsxSemantic, movzxSemantic } from "#x86/semantics/mov.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { WASM_CPU_LAZY_FLAGS_KIND, WASM_CPU_STATE_OFFSETS } from "#wasm/cpu-state-layout.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import {
  assertLazyFlagState,
  readWasmCpuStateChannel,
  readWasmCpuStateField,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { wasmBodyMemoryAccesses, wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import { irBlockBody, irBlockCompleted, instantiateIrBlock } from "./harness.js";
import { isStateRead, isStateWrite, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

// The stage's end-to-end slice: semantics -> IrBlockBuilder -> emit ->
// instantiate -> run -> assert cpu state memory through the host view.

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

function entryActions(block: IrBlock): readonly Action[] {
  return block.body.actions;
}

function touchedGprSlots(block: IrBlock): StateSlot[] {
  return entryActions(block).flatMap((action) =>
    (isStateRead(action) || isStateWrite(action)) && action.op.slot.kind === "gpr"
      ? [action.op.slot]
      : []
  );
}

function assertCompleted(exit: bigint): void {
  strictEqual(exit, irBlockCompleted);
}

test("mov r32, imm32 sets the register bytes and eip and falls through", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x401000, 0x401005));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x12345678);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x401005);
});

test("mov r32, r32 copies the source register and leaves it intact", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0xcafe1234 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0xcafe1234);
  strictEqual(readRegister(stateView, "ebx"), 0xcafe1234);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x1002);
});

test("ordinary state writes leave lazy flag metadata untouched", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xcafe1234,
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, 32),
    lazyFlagsA: 0x1111_2222,
    lazyFlagsB: 0x3333_4444
  });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xcafe1234);
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsKind"), lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, 32));
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsA"), 0x1111_2222);
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsB"), 0x3333_4444);
});

test("generic state actions load and store the lazy flags kind byte channel", async () => {
  const values = new ValueTable();
  const oldKindByte = values.addActionOutput(fitsUnsigned(8));
  const newKindByteValue = lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.ADD, 16);
  const newKindByte = values.const(newKindByteValue);
  const block: IrBlock = {
    body: {
      actions: [
        stateRead(oldKindByte, lazyFlagsKindChannel),
        stateWrite(lazyFlagsBChannel, oldKindByte),
        stateWrite(lazyFlagsKindChannel, newKindByte)
      ]
    },
    values
  };
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, 32),
    lazyFlagsB: 0x3333_4444
  });

  assertCompleted(run());
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsKind"), newKindByteValue);
  strictEqual(readWasmCpuStateField(stateView, "lazyFlagsB"), lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, 32));
});

test("chained movs forward one read to both destinations", async () => {
  const builder = createIrBlockBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.addInstruction(mov, [regBinding("ecx"), regBinding("ebx")], loc(0x1002, 0x1004));

  const block = builder.finish();

  // The second mov forwards the first read instead of reading ebx.
  strictEqual(
    entryActions(block).filter(
      (action) => isStateRead(action) && action.op.slot.kind === "gpr"
    ).length,
    1
  );

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0xdeadbeef });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xdeadbeef);
  strictEqual(readRegister(stateView, "ecx"), 0xdeadbeef);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x1004);
});

test("xchg eax, ebx swaps the registers", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111111, ebx: 0x22222222 });
  assertCompleted(run());
  // The pinning rule is load-bearing here: reloading ebx at its use would
  // observe the just-stored eax and leave both registers equal.
  strictEqual(readRegister(stateView, "eax"), 0x22222222);
  strictEqual(readRegister(stateView, "ebx"), 0x11111111);
});

test("xchg eax, eax emits no register-state Wasm access", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("eax")], loc(0x1000, 0x1001));

  const block = builder.finish();
  const body = irBlockBody(block).encode();

  deepStrictEqual(
    wasmBodyMemoryAccesses(body).filter(
      (access) =>
        access.memoryIndex === wasmMemoryIndex.cpuState &&
        access.offset === WASM_CPU_STATE_OFFSETS.eax
    ),
    []
  );

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111111 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x11111111);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x1001);
});

test("a mov before the xchg observes the pre-swap value", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ecx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1002, 0x1004));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111111, ebx: 0x22222222 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ecx"), 0x11111111);
  strictEqual(readRegister(stateView, "eax"), 0x22222222);
  strictEqual(readRegister(stateView, "ebx"), 0x11111111);
});

test("a byte write merges into the full register through cpu state memory", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("al"), immBinding(0x9a)], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1002, 0x1004));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234569a);
  strictEqual(readRegister(stateView, "ebx"), 0x1234569a);
});

test("a 16-bit immediate store leaves the upper register half intact", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(16), [regBinding("ax"), immBinding(0xbeef)], loc(0x1000, 0x1004));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234beef);
});

test("movzx r32, r8 zero-extends the high byte through an offset load", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movzxSemantic(8, 32), [regBinding("ebx"), regBinding("ah")], loc(0x1000, 0x1003));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x1234f678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xf6);
});

test("movsx r32, r8/r16 sign-extends through marked loads", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("ebx"), regBinding("ah")], loc(0x1000, 0x1003));
  builder.addInstruction(movsxSemantic(16, 32), [regBinding("ecx"), regBinding("ax")], loc(0x1003, 0x1006));

  const { stateView, run } = await instantiateIrBlock(builder.finish());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x1234f678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xfffffff6);
  strictEqual(readRegister(stateView, "ecx"), 0xfffff678);
});

test("add al, imm8 stays on the byte channel with byte-wide flags", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 8), [regBinding("al"), immBinding(0x70)], loc(0x1000, 0x1002));

  const block = builder.finish();

  // Register access never widens to eax.
  deepStrictEqual(touchedGprSlots(block), [gprChannel("al"), gprChannel("al")]);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x123456f0 });
  assertCompleted(run());
  // 0xf0 + 0x70 = 0x160: the byte wraps and carries out.
  strictEqual(readRegister(stateView, "eax"), 0x12345660);
  assertLazyFlagState(stateView, { kind: "ADD", width: 8, a: 0xf0, b: 0x70 });
});

test("add ax, imm16 stays on the word channel", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 16), [regBinding("ax"), immBinding(0x2001)], loc(0x1000, 0x1004));

  const block = builder.finish();

  deepStrictEqual(touchedGprSlots(block), [gprChannel("ax"), gprChannel("ax")]);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x1234f00f });
  assertCompleted(run());
  // 0xf00f + 0x2001 = 0x11010: the word wraps and carries out.
  strictEqual(readRegister(stateView, "eax"), 0x12341010);
  assertLazyFlagState(stateView, { kind: "ADD", width: 16, a: 0xf00f, b: 0x2001 });
});

test("mov ah and mov al merge through memory for a final 32-bit read", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("ah"), immBinding(0xab)], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(8), [regBinding("al"), immBinding(0xcd)], loc(0x1002, 0x1004));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1004, 0x1006));

  const block = builder.finish();

  // Pure moves: every flushed register value is a constant or read leaf —
  // no bit algebra on the register path.
  for (const action of entryActions(block)) {
    if (isStateWrite(action) && action.op.slot.kind === "gpr") {
      ok(
        ["const", "actionOutput"].includes(block.values.node(action.op.value).kind),
        "register writes carry leaves"
      );
    }
  }

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x12345678 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x1234abcd);
  strictEqual(readRegister(stateView, "ebx"), 0x1234abcd);
});

test("zero compares encode as eqz", () => {
  const builder = createIrBlockBuilder();
  const logicConditionTemplate: SemanticTemplate = (s) => {
    const result = s.binary("xor", s.get(s.reg("eax"), 32), s.const32(5));

    s.writeStatusFlagsSource({ kind: "logic", width: 32, result });
    s.set(s.reg("ebx"), s.select(s.condition("E"), s.const32(1), s.const32(0)), 32);
  };

  builder.addInstruction(logicConditionTemplate, [], loc(0x1000, 0x1003));

  const body = irBlockBody(builder.finish()).encode();
  const opcodes = wasmBodyOpcodes(body);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Eqz).length, 1);
  strictEqual(opcodes.includes(wasmOpcode.i32Eq), false);
});

test("a value used twice computes once and both uses observe it", async () => {
  // eax = ebx = eax + ebx: one shared add consumed by both stores.
  const sumIntoBoth: SemanticTemplate = (s) => {
    const sum = s.binary("add", s.get(s.operand(0), 32), s.get(s.operand(1), 32));

    s.set(s.operand(0), sum, 32);
    s.set(s.operand(1), sum, 32);
  };
  const builder: IrBlockBuilder = createIrBlockBuilder();

  builder.addInstruction(sumIntoBoth, [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const body = irBlockBody(block).encode();

  // One add for the shared sum, one for the count advance.
  strictEqual(wasmBodyOpcodes(body).filter((opcode) => opcode === wasmOpcode.i32Add).length, 2);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 100, ebx: 28 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 128);
  strictEqual(readRegister(stateView, "ebx"), 128);
});
