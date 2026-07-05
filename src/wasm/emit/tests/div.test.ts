import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import {
  memBinding,
  noMemSegment,
  regBinding,
  staticMemSegment,
  type EffectiveAddressTerms,
  type OperandBinding
} from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { decodeBytes, ok as decoded, startAddress } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import type { MemOperand, RegName } from "#x86/types.js";
import {
  assertLazyFlagState,
  createWasmCpuStateSnapshot,
  readWasmCpuStateChannel,
  readWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import { decodeExit } from "#wasm/exit.js";
import { divideErrorExit, readPageFaultExit } from "#wasm/tests/exit-fixtures.js";
import { wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import { irBlockCompleted, irBlockBody, instantiateIrBlock } from "./harness.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;
const guestByteLength = 0x10000;

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

test("decoded DIV r/m32 lowers through unsigned i64 division and writes EDX:EAX", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0xf3]));
  const block = blockOf([instruction]);
  const body = irBlockBody(block).encode();

  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64DivU), true);
  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64RemU), true);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0,
    ebx: 2,
    edx: 1,
    DF: 1,
    eip: instruction.address,
    ...allFlagsSet
  });

  strictEqual(run(), irBlockCompleted);
  strictEqual(readRegister(stateView, "eax"), 0x8000_0000);
  strictEqual(readRegister(stateView, "edx"), 0);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  strictEqual(readWasmCpuStateSnapshot(stateView).DF, 1);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), allFlagsSet);
  assertLazyFlagState(stateView, { kind: "NONE", width: 0 });
});

test("decoded IDIV r/m32 lowers through signed i64 division and keeps remainder sign", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0xfb]));
  const block = blockOf([instruction]);
  const body = irBlockBody(block).encode();

  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64DivS), true);
  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64RemS), true);
  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64Eq), true);
  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64Ne), true);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xffff_fff9,
    ebx: 2,
    edx: 0xffff_ffff,
    eip: instruction.address,
    ...allFlagsSet
  });

  strictEqual(run(), irBlockCompleted);
  strictEqual(readRegister(stateView, "eax"), 0xffff_fffd);
  strictEqual(readRegister(stateView, "edx"), 0xffff_ffff);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), allFlagsSet);
});

test("decoded IDIV r/m8 rounds an inexact boundary quotient toward zero", async () => {
  const instruction = decoded(decodeBytes([0xf6, 0xfb]));
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xaaaa_04fb,
    ebx: 0x0000_000a,
    eip: instruction.address,
    ...allFlagsSet
  });

  strictEqual(run(), irBlockCompleted);
  strictEqual(readRegister(stateView, "eax"), 0xaaaa_057f);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), allFlagsSet);
});

test("decoded IDIV r/m32 fills the widest fitting quotient without a divide error", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0xfb]));
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xffff_ffff,
    ebx: 2,
    edx: 0,
    eip: instruction.address,
    ...allFlagsSet
  });

  strictEqual(run(), irBlockCompleted);
  strictEqual(readRegister(stateView, "eax"), 0x7fff_ffff);
  strictEqual(readRegister(stateView, "edx"), 1);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), allFlagsSet);
});

test("DIV divide error leaves block state atomic", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0xf3]));
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x1234_5678,
    ebx: 0,
    edx: 0x89ab_cdef,
    eip: startAddress,
    instructionCount: 7,
    DF: 1,
    ...allFlagsSet
  });
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initialState);

  deepStrictEqual(decodeExit(run()), divideErrorExit());
  deepStrictEqual(readWasmCpuStateSnapshot(stateView), initialState);
});

test("DIV quotient overflow exits before quotient, remainder, or flag writes", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0xf3]));
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    ebx: 5,
    edx: 5,
    eip: startAddress,
    instructionCount: 7,
    ...allFlagsSet
  });
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initialState);

  deepStrictEqual(decodeExit(run()), divideErrorExit());
  deepStrictEqual(readWasmCpuStateSnapshot(stateView), initialState);
});

test("IDIV signed quotient overflow exits before wasm signed division", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0xfb]));
  const initialState = createWasmCpuStateSnapshot({
    eax: 0x8000_0000,
    ebx: 0xffff_ffff,
    edx: 0xffff_ffff,
    eip: startAddress,
    instructionCount: 7,
    ...allFlagsSet
  });
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initialState);

  deepStrictEqual(decodeExit(run()), divideErrorExit());
  deepStrictEqual(readWasmCpuStateSnapshot(stateView), initialState);
});

test("IDIV r/m16 INT32_MIN over -1 exits with divide error instead of a wasm trap", async () => {
  const instruction = decoded(decodeBytes([0x66, 0xf7, 0xfb]));
  const initialState = createWasmCpuStateSnapshot({
    eax: 0xaaaa_0000,
    ebx: 0x0000_ffff,
    edx: 0xbbbb_8000,
    eip: startAddress,
    instructionCount: 7,
    ...allFlagsSet
  });
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initialState);

  deepStrictEqual(decodeExit(run()), divideErrorExit());
  deepStrictEqual(readWasmCpuStateSnapshot(stateView), initialState);
});

test("IDIV r/m32 quotient overflow exits after the wasm division ran", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0xfb]));
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    ebx: 2,
    edx: 1,
    eip: startAddress,
    instructionCount: 7,
    ...allFlagsSet
  });
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initialState);

  deepStrictEqual(decodeExit(run()), divideErrorExit());
  deepStrictEqual(readWasmCpuStateSnapshot(stateView), initialState);
});

test("DIV memory source fault takes priority over divide error", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0x33]));
  const initialState = createWasmCpuStateSnapshot({
    eax: 0,
    ebx: guestByteLength,
    edx: 1,
    eip: startAddress,
    instructionCount: 7,
    ...allFlagsSet
  });
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, initialState);

  deepStrictEqual(decodeExit(run()), readPageFaultExit(guestByteLength));
  deepStrictEqual(readWasmCpuStateSnapshot(stateView), initialState);
});

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
      case "mem":
        return memBinding(
          effectiveAddressTermsOf(operand),
          operand.segment === undefined ? noMemSegment() : staticMemSegment(operand.segment)
        );
      case "imm":
      case "segment":
      case "relTarget":
        throw new Error(`unsupported operand in div e2e: ${instruction.spec.id}`);
    }
  });
}

function effectiveAddressTermsOf(operand: MemOperand): EffectiveAddressTerms {
  return {
    base: operand.base,
    index: operand.index,
    scale: operand.scale,
    disp: operand.disp
  };
}
