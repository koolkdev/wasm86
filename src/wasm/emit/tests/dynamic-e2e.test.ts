import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { regDynamicBinding, immBinding, regBinding } from "#ir/operands.js";
import { gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable, type ValueId } from "#ir/values.js";
import type { RegName } from "#x86/types.js";
import { aluSemantic } from "#x86/semantics/alu.js";
import { movSemantic } from "#x86/semantics/mov.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";
import { assertLazyFlagState, readWasmCpuStateChannel, writeWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";

// One emitted handler body per op+width, with the register indices arriving
// as wasm params at run time.

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

function assertCompleted(exit: bigint): void {
  strictEqual(exit, irBlockCompleted);
}

test("one add r/m32, r32 body serves several runtime register pairs", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regDynamicBinding(0), regDynamicBinding(1)], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish(), 2);

  writeWasmCpuStateSnapshot(stateView, { eax: 5, ecx: 7 });
  assertCompleted(run(0, 1));
  strictEqual(readRegister(stateView, "eax"), 12);
  strictEqual(readRegister(stateView, "ecx"), 7);
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 5, b: 7 });

  // The far end of the word table, wrapping into CF and ZF.
  writeWasmCpuStateSnapshot(stateView, { edi: 0xffffffff, esp: 1 });
  assertCompleted(run(7, 4));
  strictEqual(readRegister(stateView, "edi"), 0);
  strictEqual(readRegister(stateView, "esp"), 1);
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 });

  // Indices are masked to 0..7: 8 and 9 land on eax and ecx.
  writeWasmCpuStateSnapshot(stateView, { eax: 2, ecx: 3 });
  assertCompleted(run(8, 9));
  strictEqual(readRegister(stateView, "eax"), 5);
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 2, b: 3 });
});

test("dst == src reads the original value for the result and the flags", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regDynamicBinding(0), regDynamicBinding(1)], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish(), 2);

  writeWasmCpuStateSnapshot(stateView, { ebx: 0x21 });
  assertCompleted(run(3, 3));
  strictEqual(readRegister(stateView, "ebx"), 0x42);
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 0x21, b: 0x21 });

  // The flag expressions consume the dynamic read after the dynamic store:
  // a reload there would see the doubled value and lose the carry.
  writeWasmCpuStateSnapshot(stateView, { ebx: 0x80000000 });
  assertCompleted(run(3, 3));
  strictEqual(readRegister(stateView, "ebx"), 0);
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: 0x8000_0000, b: 0x8000_0000 });
});

test("a static read before a dynamic write to the same register keeps the old value", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ecx"), regBinding("ebx")], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), immBinding(0x99)], loc(0x1002, 0x1008));

  const { stateView, run } = await instantiateIrBlock(builder.finish(), 1);

  writeWasmCpuStateSnapshot(stateView, { ebx: 0x42, ecx: 0 });
  assertCompleted(run(3));
  strictEqual(readRegister(stateView, "ecx"), 0x42);
  strictEqual(readRegister(stateView, "ebx"), 0x99);
});

test("xchg r/mDyn, ebx swaps through the dynamic slot", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(xchgSemantic(32), [regDynamicBinding(0), regBinding("ebx")], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish(), 1);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x111, ebx: 0x222 });
  assertCompleted(run(0));
  strictEqual(readRegister(stateView, "eax"), 0x222);
  strictEqual(readRegister(stateView, "ebx"), 0x111);

  // The self-aliasing exchange: dynamic dst is ebx itself.
  writeWasmCpuStateSnapshot(stateView, { ebx: 0x333 });
  assertCompleted(run(3));
  strictEqual(readRegister(stateView, "ebx"), 0x333);
});

test("one add r/m8, r8 body serves low and high byte registers", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 8), [regDynamicBinding(0), regDynamicBinding(1)], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish(), 2);

  // al += cl: only the low byte of eax changes.
  writeWasmCpuStateSnapshot(stateView, { eax: 0x11111105, ecx: 0x22222203 });
  assertCompleted(run(0, 1));
  strictEqual(readRegister(stateView, "eax"), 0x11111108);
  strictEqual(readRegister(stateView, "ecx"), 0x22222203);

  // ah += ch: high bytes, with a carry out of the byte.
  writeWasmCpuStateSnapshot(stateView, { eax: 0x1111f011, ecx: 0x22223022 });
  assertCompleted(run(4, 5));
  strictEqual(readRegister(stateView, "eax"), 0x11112011);
  assertLazyFlagState(stateView, { kind: "ADD", width: 8, a: 0xf0, b: 0x30 });

  // bh += al: a high destination with a low source in another word.
  writeWasmCpuStateSnapshot(stateView, { ebx: 0x11110711, eax: 2 });
  assertCompleted(run(7, 0));
  strictEqual(readRegister(stateView, "ebx"), 0x11110911);
  assertLazyFlagState(stateView, { kind: "ADD", width: 8, a: 7, b: 2 });

  // ah += ah: the self-aliasing high-byte case.
  writeWasmCpuStateSnapshot(stateView, { eax: 0x2100 });
  assertCompleted(run(4, 4));
  strictEqual(readRegister(stateView, "eax"), 0x4200);
  assertLazyFlagState(stateView, { kind: "ADD", width: 8, a: 0x21, b: 0x21 });
});

// The index can be any expression, not just a bound external: here the
// register fields are computed from a raw modrm byte inside the block.
function modrmRegField(values: ValueTable, modrm: ValueId): ValueId {
  return values.binary(
    "and",
    values.binary("shr_u", modrm, values.const(3)),
    values.const(7)
  );
}

test("a computed index extracts the registers from a modrm-style external", async () => {
  const values = new ValueTable();
  const modrm = values.external(0);
  const reg = modrmRegField(values, modrm);
  const rm = values.binary("and", modrm, values.const(7));
  const loaded = values.addActionOutput();
  const block: IrBlock = {
    entry: 0,
    regions: [
      {
        id: 0,
        kind: "entry",
        actions: [
          { kind: "readState", output: loaded, slot: { kind: "gprDynamic", index: reg, byteLength: 4 } },
          { kind: "writeState", slot: { kind: "gprDynamic", index: rm, byteLength: 4 }, value: loaded }
        ]
      }
    ],
    values
  };

  const { stateView, run } = await instantiateIrBlock(block, 1);

  // mov rm, reg with modrm 0xd1: reg = edx, rm = ecx.
  writeWasmCpuStateSnapshot(stateView, { edx: 0xfeedface, ecx: 0 });
  assertCompleted(run(0xd1));
  strictEqual(readRegister(stateView, "ecx"), 0xfeedface);
  strictEqual(readRegister(stateView, "edx"), 0xfeedface);
});

test("a computed index drives byte access through its two address pushes", async () => {
  const values = new ValueTable();
  const reg = modrmRegField(values, values.external(0));
  const block: IrBlock = {
    entry: 0,
    regions: [
      {
        id: 0,
        kind: "entry",
        actions: [
          { kind: "writeState", slot: { kind: "gprDynamic", index: reg, byteLength: 1 }, value: values.const(0x7f) }
        ]
      }
    ],
    values
  };

  const { stateView, run } = await instantiateIrBlock(block, 1);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11110011 });
  assertCompleted(run(4 << 3)); // reg field = ah
  strictEqual(readRegister(stateView, "eax"), 0x11117f11);
});

test("a 16-bit dynamic access touches two bytes of the indexed word", async () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 16), [regDynamicBinding(0), regDynamicBinding(1)], loc(0x1000, 0x1002));

  const { stateView, run } = await instantiateIrBlock(builder.finish(), 2);

  // si += dx wraps the word; the upper halves stay untouched.
  writeWasmCpuStateSnapshot(stateView, { esi: 0xaaaa8001, edx: 0xbbbb8002 });
  assertCompleted(run(6, 2));
  strictEqual(readRegister(stateView, "esi"), 0xaaaa0003);
  strictEqual(readRegister(stateView, "edx"), 0xbbbb8002);
  assertLazyFlagState(stateView, { kind: "ADD", width: 16, a: 0x8001, b: 0x8002 });
});
