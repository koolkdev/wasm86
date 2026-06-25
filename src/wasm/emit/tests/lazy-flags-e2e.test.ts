import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import type { IrBlock } from "#ir/block.js";
import { immBinding, regBinding, type OperandBinding } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import { CONDITIONS, type FlagBoolExpr } from "#x86/conditions.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { x86EflagsBitOffset, x86Flags, x86StatusFlags, type X86Flag, type X86StatusFlag } from "#x86/flags.js";
import type { OperandWidth } from "#x86/types.js";
import { WASM_CPU_LAZY_FLAGS_KIND } from "#wasm/cpu-state-layout.js";
import {
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { aluReference, type AluFlags } from "./reference.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";

type SubLazyFlagsCase = Readonly<{ width: OperandWidth; left: number; right: number }>;

test("jcc resolves seeded SUB32 lazy flag metadata", async () => {
  const cases = [
    { name: "je taken", bytes: [0x74, 0x20], left: 0x1234_5678, right: 0x1234_5678, taken: true },
    { name: "je not taken", bytes: [0x74, 0x20], left: 0x1234_5678, right: 0x8765_4321, taken: false },
    { name: "jne taken", bytes: [0x75, 0x20], left: 0x1234_5678, right: 0x8765_4321, taken: true },
    { name: "jne not taken", bytes: [0x75, 0x20], left: 0x1234_5678, right: 0x1234_5678, taken: false }
  ] as const;

  for (const entry of cases) {
    const instruction = ok(decodeBytes(entry.bytes));
    const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));
    const lazyFlags = aluReference("sub", 32, entry.left, entry.right).flags;
    const concreteFlags = oppositeStatusFlags(lazyFlags);

    writeWasmCpuStateSnapshot(stateView, {
      eip: 0x1000,
      ...subLazyFlagsState({ width: 32, left: entry.left, right: entry.right }),
      ...concreteFlags
    });

    strictEqual(run(), irBlockCompleted, entry.name);
    strictEqual(
      readWasmCpuStateChannel(stateView, eipChannel),
      entry.taken ? relTarget(instruction) : instruction.nextEip,
      `${entry.name} eip`
    );
    assertStatusFlags(stateView, concreteFlags, entry.name);
  }
});

test("setcc resolves seeded SUB32 lazy flag metadata", async () => {
  const cases: readonly SubLazyFlagsCase[] = [
    { width: 32, left: 0x0000_0000, right: 0x0000_0001 },
    { width: 32, left: 0x8000_0000, right: 0x0000_0001 },
    { width: 32, left: 0x1234_5678, right: 0x1234_5678 }
  ];
  const { stateView, run } = await instantiateIrBlock(setbeBlock());

  for (const entry of cases) {
    const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
    const concreteFlags = oppositeStatusFlags(lazyFlags);
    const label = `setbe with SUB32 ${hex(entry.left)} - ${hex(entry.right)}`;

    writeWasmCpuStateSnapshot(stateView, {
      eax: 0x55aa_5500,
      eip: 0x1000,
      ...subLazyFlagsState(entry),
      ...concreteFlags
    });

    strictEqual(run(), irBlockCompleted, label);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      0x55aa_5500 + (evaluateCondition(CONDITIONS.BE.expr, flagSet(lazyFlags)) ? 1 : 0),
      label
    );
    strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x1003, `${label} eip`);
    assertStatusFlags(stateView, concreteFlags, label);
  }
});

test("setcc resolves seeded SUB8 and SUB16 lazy flag metadata", async () => {
  const cases: readonly SubLazyFlagsCase[] = [
    { width: 8, left: 0x1200, right: 0x3401 },
    { width: 8, left: 0x1280, right: 0x3401 },
    { width: 16, left: 0x9999_1234, right: 0x7777_1234 },
    { width: 16, left: 0x9999_8000, right: 0x7777_0001 }
  ];
  const { stateView, run } = await instantiateIrBlock(setbeBlock());

  for (const entry of cases) {
    const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
    const concreteFlags = oppositeStatusFlags(lazyFlags);
    const label = `setbe with SUB${entry.width} ${hex(entry.left)} - ${hex(entry.right)}`;

    writeWasmCpuStateSnapshot(stateView, {
      eax: 0x55aa_5500,
      eip: 0x1000,
      ...subLazyFlagsState(entry),
      ...concreteFlags
    });

    strictEqual(run(), irBlockCompleted, label);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      0x55aa_5500 + (evaluateCondition(CONDITIONS.BE.expr, flagSet(lazyFlags)) ? 1 : 0),
      label
    );
    strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x1003, `${label} eip`);
    assertStatusFlags(stateView, concreteFlags, label);
  }
});

test("pushfd resolves seeded SUB32 lazy flag metadata", async () => {
  const entry = { width: 32, left: 0x0000_0000, right: 0x0000_0001 } as const;
  const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
  const concreteFlags = oppositeStatusFlags(lazyFlags);
  const nonStatusFlags = { TF: 1, DF: 1, NT: 1, AC: 1, ID: 1 } as const;
  const instruction = ok(decodeBytes([0x9c]));

  const { stateView, guestView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, {
    esp: 0x40,
    eip: instruction.address,
    ...subLazyFlagsState(entry),
    ...concreteFlags,
    ...nonStatusFlags
  });

  strictEqual(run(), irBlockCompleted);
  strictEqual(guestView.getUint32(0x3c, true), expectedPushfdImage({ ...lazyFlags, ...nonStatusFlags }));
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esp")), 0x3c);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  assertStatusFlags(stateView, concreteFlags, "pushfd");
});

function setbeBlock(): IrBlock {
  return blockOf([ok(decodeBytes([0x0f, 0x96, 0xc0]))]);
}

function blockOf(instructions: readonly IsaDecodedInstruction[]): IrBlock {
  const builder = createIrBlockBuilder();

  for (const instruction of instructions) {
    builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), loc(instruction.address, instruction.nextEip));
  }

  return builder.finish();
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    switch (operand.kind) {
      case "reg":
        return regBinding(operand.alias.name);
      case "imm":
        return immBinding(operand.value);
      case "relTarget":
        return immBinding(operand.target);
      case "mem":
        throw new Error(`unsupported memory operand in lazy flag e2e: ${instruction.spec.id}`);
    }
  });
}

function relTarget(instruction: IsaDecodedInstruction): number {
  const target = instruction.operands.find((operand) => operand.kind === "relTarget");

  if (target === undefined) {
    throw new Error(`missing branch target in lazy flag e2e: ${instruction.spec.id}`);
  }

  return target.target;
}

function subLazyFlagsState(entry: SubLazyFlagsCase) {
  return {
    lazyFlagsKind: WASM_CPU_LAZY_FLAGS_KIND.SUB,
    lazyFlagsWidth: entry.width,
    lazyFlagsA: entry.left,
    lazyFlagsB: entry.right
  };
}

function oppositeStatusFlags(flags: AluFlags): AluFlags {
  return {
    CF: flags.CF === 0 ? 1 : 0,
    PF: flags.PF === 0 ? 1 : 0,
    AF: flags.AF === 0 ? 1 : 0,
    ZF: flags.ZF === 0 ? 1 : 0,
    SF: flags.SF === 0 ? 1 : 0,
    OF: flags.OF === 0 ? 1 : 0
  };
}

function assertStatusFlags(stateView: DataView, expected: AluFlags, label: string): void {
  for (const flag of x86StatusFlags) {
    strictEqual(readWasmCpuFlagByte(stateView, flag), expected[flag], `${label} ${flag}`);
  }
}

function evaluateCondition(expr: FlagBoolExpr, flags: ReadonlySet<X86StatusFlag>): boolean {
  switch (expr.kind) {
    case "flag":
      return flags.has(expr.flag);
    case "not":
      return !evaluateCondition(expr.value, flags);
    case "and":
      return evaluateCondition(expr.a, flags) && evaluateCondition(expr.b, flags);
    case "or":
      return evaluateCondition(expr.a, flags) || evaluateCondition(expr.b, flags);
    case "xor":
      return evaluateCondition(expr.a, flags) !== evaluateCondition(expr.b, flags);
  }
}

function flagSet(flags: Readonly<Record<X86StatusFlag, number>>): ReadonlySet<X86StatusFlag> {
  return new Set(x86StatusFlags.filter((flag) => flags[flag] !== 0));
}

function expectedPushfdImage(flags: Partial<Record<X86Flag, number>>): number {
  let image = 0x202;

  for (const flag of x86Flags) {
    if (flags[flag] !== undefined && flags[flag] !== 0) {
      image |= 1 << x86EflagsBitOffset[flag];
    }
  }

  return image >>> 0;
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}
