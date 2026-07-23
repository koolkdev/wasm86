import { strictEqual } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { createInstructionFunction } from "./instruction-function.js";
import { regBinding, type OperandBinding } from "#core/instruction/bindings.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import {
  x86StatusFlags,
  type X86StatusFlag
} from "#core/flags/definitions.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import { reg32, type Reg32 } from "#core/types.js";
import {
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { decodeBytes } from "#test/support/isa-decode.js";
import {
  testFunctionCompleted,
  instantiateTestFunction
} from "./harness.js";

type StatusFlags = Readonly<Record<X86StatusFlag, 0 | 1>>;

const allFlagsSet = {
  CF: 1,
  PF: 1,
  AF: 1,
  ZF: 1,
  SF: 1,
  OF: 1
} as const satisfies StatusFlags;
test("two adds in one block leave the second add's lazy flag source", async () => {
  // 0x7fff_fffe + 1 + 1: the adds disagree on SF/OF/AF/PF, so the collapsed
  // stores observably carry the second instruction's values.
  const firstResult = decodeBytes([0x01, 0xcb]);

  assert(firstResult.kind === "instruction", "first add did not decode");
  const first = firstResult.instruction;
  const secondResult = decodeBytes([0x01, 0xcb], first.nextEip);

  assert(secondResult.kind === "instruction", "second add did not decode");
  const second = secondResult.instruction;
  const builder = createInstructionFunction();

  builder.add(first.spec.semantics, bindingsFor(first), loc(first.address, first.nextEip));
  builder.add(second.spec.semantics, bindingsFor(second), loc(second.address, second.nextEip));

  const block = builder.finish();

  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: 0x7fff_fffe,
    ecx: 0x0000_0001,
    eip: first.address,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, 32),
    ...allFlagsSet
  };
  const { stateView, run } = await instantiateTestFunction(block);

  writeWasmCpuStateSnapshot(stateView, initial);
  strictEqual(run(), testFunctionCompleted);
  assertState(
    stateView,
    {
      regs: { ebx: 0x8000_0000, ecx: 0x0000_0001 },
      eip: second.nextEip,
      flags: allFlagsSet
    },
    "two adds"
  );
  assertLazyFlagState(
    stateView,
    { kind: "ADD", width: 32, a: 0x7fff_ffff, b: 0x0000_0001 },
    "two adds"
  );
});

function assertState(
  stateView: DataView,
  expected: Readonly<{
    regs: Partial<Record<Reg32, number>>;
    eip: number;
    flags: StatusFlags;
  }>,
  label: string
): void {
  for (const name of reg32) {
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel(name)), expected.regs[name] ?? 0, `${label} ${name}`);
  }

  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), expected.eip, `${label} eip`);

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
