import { deepStrictEqual, ok as assertOk, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, regBinding, type OperandBinding } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { decodeBytes, ok as decoded } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import {
  assertLazyFlagState,
  readWasmCpuStateChannel,
  readWasmCpuStateSnapshot,
  wasmCpuStatusFlagsOf,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import { wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import { irBlockBody, irBlockCompleted, instantiateIrBlock } from "./harness.js";

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

function assertCompleted(exit: bigint): void {
  strictEqual(exit, irBlockCompleted);
}

type SignedProductTruncationCase = Readonly<{
  name: string;
  width: Extract<OperandWidth, 16 | 32>;
  left: number;
  right: number;
  truncatedDiffers: number;
}>;

for (const entry of [
  { name: "i16 max times one is stable", width: 16, left: 0x7fff, right: 1, truncatedDiffers: 0 },
  { name: "i16 min times one is stable", width: 16, left: 0x8000, right: 1, truncatedDiffers: 0 },
  { name: "i16 max times two differs", width: 16, left: 0x7fff, right: 2, truncatedDiffers: 1 },
  { name: "i16 min times minus one differs", width: 16, left: 0x8000, right: -1, truncatedDiffers: 1 },
  { name: "i32 max times one is stable", width: 32, left: 0x7fff_ffff, right: 1, truncatedDiffers: 0 },
  { name: "i32 min times one is stable", width: 32, left: 0x8000_0000, right: 1, truncatedDiffers: 0 },
  { name: "i32 half range times two differs", width: 32, left: 0x4000_0000, right: 2, truncatedDiffers: 1 },
  { name: "i32 min times minus one differs", width: 32, left: 0x8000_0000, right: -1, truncatedDiffers: 1 }
] as const satisfies readonly SignedProductTruncationCase[]) {
  test(`signed product truncation lowering: ${entry.name}`, async () => {
    const builder = createIrBlockBuilder();
    const template: SemanticTemplate = (s) => {
      const left = s.extend64(entry.width, s.get(s.reg("eax"), 32), true);
      const right = s.extend64(entry.width, s.get(s.reg("ebx"), 32), true);
      const fullProduct = s.binary64("mul", left, right);
      const truncatedProduct = s.extend64(entry.width, s.project64(entry.width, fullProduct), true);
      const truncatedDiffers = s.compare64("ne", fullProduct, truncatedProduct);

      s.set(s.reg("edx"), truncatedDiffers, 32);
    };

    builder.addInstruction(template, [], loc(0x1000, 0x1001));

    const { stateView, run } = await instantiateIrBlock(builder.finish());

    writeWasmCpuStateSnapshot(stateView, { eax: entry.left, ebx: entry.right });
    assertCompleted(run());
    strictEqual(readRegister(stateView, "edx"), entry.truncatedDiffers);
  });
}

test("i32 multiply lowers to wasm i32.mul", async () => {
  const builder = createIrBlockBuilder();
  const template: SemanticTemplate = (s) => {
    s.set(
      s.reg("edx"),
      s.binary("mul", s.get(s.reg("eax"), 32), s.get(s.reg("ebx"), 32)),
      32
    );
  };

  builder.addInstruction(template, [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const body = irBlockBody(block).encode();

  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i32Mul), true);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x4000_0000, ebx: 2 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "edx"), 0x8000_0000);
});

test("unsigned dword product high-half lowering uses i64 shift", async () => {
  const builder = createIrBlockBuilder();
  const template: SemanticTemplate = (s) => {
    const left = s.extend64(32, s.get(s.reg("eax"), 32), false);
    const right = s.extend64(32, s.get(s.reg("ebx"), 32), false);
    const fullProduct = s.binary64("mul", left, right);
    const high = s.project64(32, s.binary64("shr_u", fullProduct, s.extend64(32, s.const32(32), false)));

    s.set(s.reg("edx"), high, 32);
  };

  builder.addInstruction(template, [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const body = irBlockBody(block).encode();

  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64ExtendI32U), true);
  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64ShrU), true);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0xffff_ffff, ebx: 2 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "edx"), 1);
});

test("decoded imul lowers through i64 product and writes explicit flags", async () => {
  const instruction = decoded(decodeBytes([0x0f, 0xaf, 0xcb]));
  const block = blockOf([instruction]);
  const body = irBlockBody(block).encode();

  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64Mul), true);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    ecx: 0x4000_0000,
    ebx: 2,
    eip: instruction.address
  });

  assertCompleted(run());
  strictEqual(readRegister(stateView, "ecx"), 0x8000_0000);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), {
    CF: 1,
    PF: 1,
    AF: 0,
    ZF: 0,
    SF: 0,
    OF: 1
  });
  assertLazyFlagState(stateView, { kind: "NONE", width: 0 });
});

test("decoded implicit mul lowers through unsigned i64 product and writes EDX:EAX", async () => {
  const instruction = decoded(decodeBytes([0xf7, 0xe3]));
  const block = blockOf([instruction]);
  const body = irBlockBody(block).encode();

  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64ExtendI32U), true);
  strictEqual(wasmBodyOpcodes(body).includes(wasmOpcode.i64ShrU), true);

  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0xffff_ffff,
    ebx: 2,
    edx: 0x1234_5678,
    eip: instruction.address
  });

  assertCompleted(run());
  strictEqual(readRegister(stateView, "eax"), 0xffff_fffe);
  strictEqual(readRegister(stateView, "edx"), 1);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(stateView)), {
    CF: 1,
    PF: 1,
    AF: 0,
    ZF: 0,
    SF: 0,
    OF: 1
  });
  assertLazyFlagState(stateView, { kind: "NONE", width: 0 });
});

function blockOf(instructions: readonly IsaDecodedInstruction[]) {
  const builder = createIrBlockBuilder();

  for (const instruction of instructions) {
    builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), loc(instruction.address, instruction.nextEip));
  }

  return builder.finish();
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    if (operand.kind === "reg") {
      return regBinding(operand.alias.name);
    }

    assertOk(operand.kind === "imm", `unsupported operand in mul e2e: ${instruction.spec.id}`);
    return immBinding(operand.value);
  });
}
