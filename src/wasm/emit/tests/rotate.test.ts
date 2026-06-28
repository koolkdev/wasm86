import { deepStrictEqual, ok as assertOk, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, regBinding, type OperandBinding } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import {
  readWasmCpuStateChannel,
  readWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { decodeBytes, ok as decoded } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import type { RegName } from "#x86/types.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";

const preservedFlags = { PF: 1, AF: 1, ZF: 1, SF: 1 } as const;
const cfOfClear = { ...preservedFlags, CF: 0, OF: 0 } as const;
const cfOfSet = { ...preservedFlags, CF: 1, OF: 1 } as const;

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

function assertCompleted(exit: bigint): void {
  strictEqual(exit, irBlockCompleted);
}

test("decoded ROL uses CL low byte and preserves non-rotate flags", async () => {
  const instruction = decoded(decodeBytes([0xd3, 0xc3]));
  const block = blockOf(instruction);
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    ebx: 0x1234_5678,
    ecx: 0xffff_ff04,
    ...cfOfSet,
    eip: instruction.address
  });

  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0x2345_6781);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), {
    ...preservedFlags,
    CF: 1,
    OF: 0
  });
});

test("decoded ROR word keeps high destination bits untouched", async () => {
  const instruction = decoded(decodeBytes([0x66, 0xd1, 0xc8]));
  const block = blockOf(instruction);
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xaaaa_0001,
    ...cfOfClear,
    eip: instruction.address
  });

  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0xaaaa_8000);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), {
    ...preservedFlags,
    CF: 1,
    OF: 1
  });
});

test("decoded RCL byte rotates through old carry", async () => {
  const instruction = decoded(decodeBytes([0xd0, 0xd3]));
  const block = blockOf(instruction);
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    ebx: 0xaaaa_0000,
    ...cfOfSet,
    eip: instruction.address
  });

  assertCompleted(run());
  strictEqual(readRegister(stateView, "ebx"), 0xaaaa_0001);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), {
    ...preservedFlags,
    CF: 0,
    OF: 0
  });
});

test("decoded RCR dword rotates through old carry", async () => {
  const instruction = decoded(decodeBytes([0xd1, 0xd8]));
  const block = blockOf(instruction);
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0,
    ...cfOfSet,
    eip: instruction.address
  });

  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0x8000_0000);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), {
    ...preservedFlags,
    CF: 0,
    OF: 1
  });
});

function blockOf(instruction: IsaDecodedInstruction) {
  const builder = createIrBlockBuilder();

  builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), loc(instruction.address, instruction.nextEip));
  return builder.finish();
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    if (operand.kind === "reg") {
      return regBinding(operand.alias.name);
    }

    assertOk(operand.kind === "imm", `unsupported operand in rotate e2e: ${instruction.spec.id}`);
    return immBinding(operand.value);
  });
}
