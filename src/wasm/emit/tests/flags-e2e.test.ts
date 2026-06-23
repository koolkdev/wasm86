import { ok as assertOk, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { regBinding, type OperandBinding } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { WriteStateAction } from "#ir/actions.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { x86StatusFlags } from "#x86/flags.js";
import type { WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { reg32, type Reg32 } from "#x86/types.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import { readWasmCpuFlagByte, readWasmCpuStateChannel, writeWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import { irBlockBody, irBlockCompleted, instantiateIrBlock } from "./harness.js";
import { aluReference, type AluFlags, type AluOp } from "./reference.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const satisfies AluFlags;

// ALU r32 forms through the action pipeline, checked against reference.ts.

// dst=ebx, src=ecx for every form: modrm 0xcb = mod 11, reg ecx, rm ebx.
const aluCases: readonly Readonly<{
  name: string;
  op: AluOp;
  bytes: readonly number[];
}>[] = [
  { name: "add ebx, ecx", op: "add", bytes: [0x01, 0xcb] },
  { name: "or ebx, ecx", op: "or", bytes: [0x09, 0xcb] },
  { name: "and ebx, ecx", op: "and", bytes: [0x21, 0xcb] },
  { name: "sub ebx, ecx", op: "sub", bytes: [0x29, 0xcb] },
  { name: "xor ebx, ecx", op: "xor", bytes: [0x31, 0xcb] },
  { name: "cmp ebx, ecx", op: "cmp", bytes: [0x39, 0xcb] },
  { name: "test ebx, ecx", op: "test", bytes: [0x85, 0xcb] }
];

// Edge values per pair position: zero results, carries, signed overflow in
// both directions, aux carry, and mixed bits for parity.
const operandPairs: readonly Readonly<{ left: number; right: number }>[] = [
  { left: 0x0000_0000, right: 0x0000_0000 },
  { left: 0xffff_ffff, right: 0x0000_0001 },
  { left: 0x7fff_ffff, right: 0x0000_0001 },
  { left: 0x8000_0000, right: 0x0000_0001 },
  { left: 0x8000_0000, right: 0x8000_0000 },
  { left: 0x0000_0001, right: 0x0000_0002 },
  { left: 0x0000_000f, right: 0x0000_0001 },
  { left: 0x1234_5678, right: 0x9abc_def0 }
];

for (const aluCase of aluCases) {
  test(`${aluCase.name} matches the SDM reference across edge values`, async () => {
    for (const pair of operandPairs) {
      const label = `${aluCase.name} with ${hex(pair.left)}, ${hex(pair.right)}`;
      const instruction = ok(decodeBytes(aluCase.bytes));
      const initial: Partial<WasmCpuStateSnapshot> = {
        ebx: pair.left,
        ecx: pair.right,
        eip: instruction.address,
        ...allFlagsSet
      };
      const reference = aluReference(aluCase.op, 32, pair.left, pair.right);

      const builder = createIrBlockBuilder();

      builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), loc(instruction.address, instruction.nextEip));

      const { stateView, run } = await instantiateIrBlock(builder.finish());

      writeWasmCpuStateSnapshot(stateView, initial);
      strictEqual(run(), irBlockCompleted, label);
      assertState(
        stateView,
        { regs: { ebx: reference.result, ecx: pair.right }, eip: instruction.nextEip, flags: reference.flags },
        label
      );
    }
  });
}

test("two adds in one block store each flag byte once, with the second add's flags", async () => {
  // 0x7fff_fffe + 1 + 1: the adds disagree on SF/OF/AF/PF, so the collapsed
  // stores observably carry the second instruction's values.
  const first = ok(decodeBytes([0x01, 0xcb]));
  const second = ok(decodeBytes([0x01, 0xcb], first.nextEip));
  const builder = createIrBlockBuilder();

  builder.addInstruction(first.spec.semantics, bindingsFor(first), loc(first.address, first.nextEip));
  builder.addInstruction(second.spec.semantics, bindingsFor(second), loc(second.address, second.nextEip));

  const block = builder.finish();

  // Dead flag writes collapse in the contract: one writeState per flag...
  const entry = block.regions[0]!;

  assertOk(entry.kind === "entry", "first region is the entry");

  const flagWrites = entry.actions.filter(
    (action): action is WriteStateAction => action.kind === "writeState" && action.slot.kind === "flag"
  );

  strictEqual(flagWrites.length, x86StatusFlags.length);
  strictEqual(new Set(flagWrites.map((write) => write.slot)).size, x86StatusFlags.length);

  // ...and in the encoding: exactly six byte stores.
  const body = irBlockBody(block).encode();

  strictEqual(wasmBodyOpcodes(body).filter((opcode) => opcode === wasmOpcode.i32Store8).length, 6);

  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: 0x7fff_fffe,
    ecx: 0x0000_0001,
    eip: first.address,
    ...allFlagsSet
  };
  // ebx threads through the two adds; the block ends with the second add's flags.
  const afterFirst = aluReference("add", 32, 0x7fff_fffe, 0x0000_0001);
  const reference = aluReference("add", 32, afterFirst.result, 0x0000_0001);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, initial);
  strictEqual(run(), irBlockCompleted);
  assertState(
    stateView,
    { regs: { ebx: reference.result, ecx: 0x0000_0001 }, eip: second.nextEip, flags: reference.flags },
    "two adds"
  );
});

function assertState(
  stateView: DataView,
  expected: Readonly<{ regs: Partial<Record<Reg32, number>>; eip: number; flags: AluFlags }>,
  label: string
): void {
  for (const name of reg32) {
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel(name)), expected.regs[name] ?? 0, `${label} ${name}`);
  }

  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), expected.eip, `${label} eip`);

  for (const flag of x86StatusFlags) {
    strictEqual(readWasmCpuFlagByte(stateView, flag), expected.flags[flag], `${label} ${flag}`);
  }
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    if (operand.kind !== "reg" || operand.alias.width !== 32) {
      throw new Error(`unsupported operand binding for the flags e2e: ${operand.kind}`);
    }

    return regBinding(operand.alias.base);
  });
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}
