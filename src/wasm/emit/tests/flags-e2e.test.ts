import { ok as assertOk, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import { regBinding, type OperandBinding } from "#ir/operands.js";
import { eipChannel, gprChannel, lazyFlagsKindChannel } from "#ir/slots.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { x86StatusFlags } from "#x86/flags.js";
import type { WasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { reg32, type Reg32 } from "#x86/types.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { WASM_CPU_LAZY_FLAGS_KIND, WASM_CPU_STATE_OFFSETS } from "#wasm/cpu-state-layout.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import {
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { wasmBodyMemoryAccesses } from "#wasm/tests/body-opcodes.js";
import { irBlockBody, irBlockCompleted, instantiateIrBlock } from "./harness.js";
import { aluReference, type AluFlags, type AluOp } from "./reference.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const satisfies AluFlags;

// ALU r32 forms through the action pipeline, checked against reference.ts.

// dst=ebx, src=ecx for every form: modrm 0xcb = mod 11, reg ecx, rm ebx.
const aluCases: readonly Readonly<{
  name: string;
  op: AluOp;
  bytes: readonly number[];
  carryIn?: number;
}>[] = [
  { name: "add ebx, ecx", op: "add", bytes: [0x01, 0xcb] },
  { name: "adc ebx, ecx", op: "adc", bytes: [0x11, 0xcb], carryIn: 1 },
  { name: "or ebx, ecx", op: "or", bytes: [0x09, 0xcb] },
  { name: "and ebx, ecx", op: "and", bytes: [0x21, 0xcb] },
  { name: "sub ebx, ecx", op: "sub", bytes: [0x29, 0xcb] },
  { name: "sbb ebx, ecx", op: "sbb", bytes: [0x19, 0xcb], carryIn: 1 },
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
      const reference = aluReference(aluCase.op, 32, pair.left, pair.right, aluCase.carryIn ?? 0);

      const builder = createIrBlockBuilder();

      builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), loc(instruction.address, instruction.nextEip));

      const { stateView, run } = await instantiateIrBlock(builder.finish());

      writeWasmCpuStateSnapshot(stateView, initial);
      strictEqual(run(), irBlockCompleted, label);
      if (aluCase.op === "add" || aluCase.op === "sub" || aluCase.op === "cmp") {
        assertState(
          stateView,
          { regs: { ebx: reference.result, ecx: pair.right }, eip: instruction.nextEip, flags: allFlagsSet },
          label
        );
        assertLazyFlagState(
          stateView,
          { kind: aluCase.op === "add" ? "ADD" : "SUB", width: 32, a: pair.left, b: pair.right },
          label
        );
      } else if (aluCase.op === "and" || aluCase.op === "or" || aluCase.op === "xor" || aluCase.op === "test") {
        assertState(
          stateView,
          { regs: { ebx: reference.result, ecx: pair.right }, eip: instruction.nextEip, flags: allFlagsSet },
          label
        );
        assertLazyFlagState(
          stateView,
          { kind: "LOGIC_RESULT", width: 32, a: logicLazyResult(aluCase.op, pair.left, pair.right) },
          label
        );
      } else {
        assertState(
          stateView,
          { regs: { ebx: reference.result, ecx: pair.right }, eip: instruction.nextEip, flags: reference.flags },
          label
        );
        assertLazyFlagState(stateView, { kind: "NONE", width: 0 }, label);
      }
    }
  });
}

test("two adds in one block store one lazy add record, with the second add's source", async () => {
  // 0x7fff_fffe + 1 + 1: the adds disagree on SF/OF/AF/PF, so the collapsed
  // stores observably carry the second instruction's values.
  const first = ok(decodeBytes([0x01, 0xcb]));
  const second = ok(decodeBytes([0x01, 0xcb], first.nextEip));
  const builder = createIrBlockBuilder();

  builder.addInstruction(first.spec.semantics, bindingsFor(first), loc(first.address, first.nextEip));
  builder.addInstruction(second.spec.semantics, bindingsFor(second), loc(second.address, second.nextEip));

  const block = builder.finish();

  // Dead flag writes collapse in the contract: one lazy ADD record for the
  // final source, with no explicit status flag stores.
  const entry = block.regions[0]!;

  assertOk(entry.kind === "entry", "first region is the entry");

  const flagWrites = entry.actions.flatMap(
    (action) => action.kind === "writeState" && action.slot.kind === "flag" ? [action.slot.flag] : []
  );

  strictEqual(flagWrites.length, 0);
  strictEqual(new Set(flagWrites).size, 0);
  strictEqual(
    entry.actions.filter((action) => action.kind === "writeState" && action.slot === lazyFlagsKindChannel).length,
    1
  );

  // ...and in the encoding: one lazy kind byte byte store.
  const body = irBlockBody(block).encode();

  strictEqual(
    wasmBodyMemoryAccesses(body).filter(
      (access) =>
        access.opcode === wasmOpcode.i32Store8 &&
        access.memoryIndex === wasmMemoryIndex.cpuState &&
        access.offset === WASM_CPU_STATE_OFFSETS.lazyFlagsKind
    ).length,
    1
  );

  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: 0x7fff_fffe,
    ecx: 0x0000_0001,
    eip: first.address,
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, 32),
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
    { regs: { ebx: reference.result, ecx: 0x0000_0001 }, eip: second.nextEip, flags: allFlagsSet },
    "two adds"
  );
  assertLazyFlagState(stateView, { kind: "ADD", width: 32, a: afterFirst.result, b: 0x0000_0001 }, "two adds");
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

function logicLazyResult(op: AluOp, left: number, right: number): number {
  switch (op) {
    case "and":
    case "test":
      return (left & right) >>> 0;
    case "or":
      return (left | right) >>> 0;
    case "xor":
      return (left ^ right) >>> 0;
    case "add":
    case "adc":
    case "sub":
    case "sbb":
    case "cmp":
      throw new Error(`unsupported logic lazy result op: ${op}`);
  }
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}
