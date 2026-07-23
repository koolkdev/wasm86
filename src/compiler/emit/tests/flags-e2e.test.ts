import { strictEqual } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { createInstructionFunction } from "./instruction-function.js";
import { regBinding, type OperandBinding } from "#core/instruction/bindings.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import { decodeBytes, ok } from "#core/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import { x86StatusFlags } from "#core/flags/definitions.js";
import { flagStateFields } from "#core/flags/layout.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import { reg32, type Reg32 } from "#core/types.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { wasmBodyMemoryAccesses } from "#compiler/encoder/tests/body-opcodes.js";
import {
  testFunctionBody,
  testFunctionCompleted,
  instantiateTestFunction,
  testModuleMemoryIndex
} from "./harness.js";
import { aluReference, type AluFlags } from "./reference.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const satisfies AluFlags;
const lazyFlagsKindStateOffset = testExecutionModel.cpuState.layout.field(
  flagStateFields.lazyKind
).offset;

test("two adds in one block store one lazy add record, with the second add's source", async () => {
  // 0x7fff_fffe + 1 + 1: the adds disagree on SF/OF/AF/PF, so the collapsed
  // stores observably carry the second instruction's values.
  const first = ok(decodeBytes([0x01, 0xcb]));
  const second = ok(decodeBytes([0x01, 0xcb], first.nextEip));
  const builder = createInstructionFunction();

  builder.add(first.spec.semantics, bindingsFor(first), loc(first.address, first.nextEip));
  builder.add(second.spec.semantics, bindingsFor(second), loc(second.address, second.nextEip));

  const block = builder.finish();
  const body = testFunctionBody(block);

  // Dead writes collapse to one encoded lazy-kind store for the final source.
  strictEqual(
    wasmBodyMemoryAccesses(body).filter(
      (access) =>
        access.opcode === wasmOpcode.i32Store8 &&
        access.memoryIndex === testModuleMemoryIndex.cpuState &&
        access.offset === lazyFlagsKindStateOffset
    ).length,
    1
  );

  const initial: Partial<WasmCpuStateSnapshot> = {
    ebx: 0x7fff_fffe,
    ecx: 0x0000_0001,
    eip: first.address,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, 32),
    ...allFlagsSet
  };
  // ebx threads through the two adds; the block ends with the second add's flags.
  const afterFirst = aluReference("add", 32, 0x7fff_fffe, 0x0000_0001);
  const reference = aluReference("add", 32, afterFirst.result, 0x0000_0001);

  const { stateView, run } = await instantiateTestFunction(block);

  writeWasmCpuStateSnapshot(stateView, initial);
  strictEqual(run(), testFunctionCompleted);
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
