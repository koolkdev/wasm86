import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import type { Reg32 } from "#x86/isa/types.js";
import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import { buildJitIrBlock } from "#backends/wasm/jit/block.js";
import { propagateJitRegisterValues } from "#backends/wasm/jit/optimization/passes/register-value-propagation.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { setTargetRegs, startAddress } from "./helpers.js";

function runRegisterValuePass(block: JitIrBlock): Readonly<{
  block: JitIrBlock;
  registerValuePropagation: Readonly<{
    removedSetCount: number;
    foldedReadCount: number;
    materializedSetCount: number;
  }>;
}> {
  const result = propagateJitRegisterValues(block);

  return {
    block: result.block,
    registerValuePropagation: {
      removedSetCount: result.registerValuePropagation.removedSetCount,
      foldedReadCount: result.registerValuePropagation.foldedReadCount,
      materializedSetCount: result.registerValuePropagation.materializedSetCount
    }
  };
}

test("runRegisterValuePass keeps transient register calculations unmaterialized until exit", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const xorEax = ok(decodeBytes([0x83, 0xf0, 0x02], movEaxEcx.nextEip));
  const addEbxEax = ok(decodeBytes([0x01, 0xc3], xorEax.nextEip));
  const movEaxZero = ok(decodeBytes([0xb8, 0x00, 0x00, 0x00, 0x00], addEbxEax.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEaxZero.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([
    movEaxEcx,
    xorEax,
    addEbxEax,
    movEaxZero,
    trap
  ]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 4);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 2);
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax", "ebx"]);
});

test("runRegisterValuePass folds repeated expensive register-value reads until exit", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const xorEax = ok(decodeBytes([0x83, 0xf0, 0x02], movEaxEcx.nextEip));
  const addEbxEax = ok(decodeBytes([0x01, 0xc3], xorEax.nextEip));
  const addEdxEax = ok(decodeBytes([0x01, 0xc2], addEbxEax.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], addEdxEax.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([
    movEaxEcx,
    xorEax,
    addEbxEax,
    addEdxEax,
    trap
  ]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 4);
  strictEqual(folded.registerValuePropagation.foldedReadCount, 3);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 3);
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax", "edx", "ebx"]);
});

test("runRegisterValuePass retains oversized expressions symbolically", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const xor1 = ok(decodeBytes([0x83, 0xf0, 0x01], movEaxEcx.nextEip));
  const xor2 = ok(decodeBytes([0x83, 0xf0, 0x02], xor1.nextEip));
  const xor3 = ok(decodeBytes([0x83, 0xf0, 0x03], xor2.nextEip));
  const xor4 = ok(decodeBytes([0x83, 0xf0, 0x04], xor3.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], xor4.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([
    movEaxEcx,
    xor1,
    xor2,
    xor3,
    xor4,
    trap
  ]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 5);
  strictEqual(folded.registerValuePropagation.foldedReadCount, 4);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 1);
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax"]);
});

test("runRegisterValuePass folds register values into indirect jump targets", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const xorEax = ok(decodeBytes([0x83, 0xf0, 0x02], movEaxEcx.nextEip));
  const jmpEax = ok(decodeBytes([0xff, 0xe0], xorEax.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([
    movEaxEcx,
    xorEax,
    jmpEax
  ]));
  const jumpInstruction = folded.block.instructions.at(-1)!;
  const jumpIndex = jumpInstruction.ir.findIndex((op) => op.op === "jump");

  strictEqual(folded.registerValuePropagation.removedSetCount, 2);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 1);
  deepStrictEqual(
    opNames(jumpInstruction.ir.slice(0, jumpIndex)),
    ["get:symbolicRead", "value.binary:xor", "set:registerMaterialization"]
  );
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax"]);
});

test("runRegisterValuePass folds register values into effective addresses", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const leaEbx = ok(decodeBytes([0x8d, 0x58, 0x04], movEaxEcx.nextEip));
  const movEaxZero = ok(decodeBytes([0xb8, 0x00, 0x00, 0x00, 0x00], leaEbx.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEaxZero.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([
    movEaxEcx,
    leaEbx,
    movEaxZero,
    trap
  ]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 3);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 2);
  strictEqual(folded.block.instructions[1]!.ir.some((op) => op.op === "address"), false);
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax", "ebx"]);
});

test("runRegisterValuePass folds register values into scaled effective addresses", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const leaEbx = ok(decodeBytes([0x8d, 0x1c, 0x45, 0x04, 0x00, 0x00, 0x00], movEaxEcx.nextEip));
  const movEaxZero = ok(decodeBytes([0xb8, 0x00, 0x00, 0x00, 0x00], leaEbx.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEaxZero.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([
    movEaxEcx,
    leaEbx,
    movEaxZero,
    trap
  ]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 3);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 2);
  strictEqual(folded.block.instructions[1]!.ir.some((op) => op.op === "address"), false);
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax", "ebx"]);
});

test("runRegisterValuePass materializes address registers before faultable memory reads", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const movEbxFromEax = ok(decodeBytes([0x8b, 0x18], movEaxEcx.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEbxFromEax.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([
    movEaxEcx,
    movEbxFromEax,
    trap
  ]));
  const loadInstruction = folded.block.instructions[1]!;

  strictEqual(folded.registerValuePropagation.removedSetCount, 1);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 1);
  strictEqual(hasSet32Reg(folded.block.instructions[0]!, "eax"), false);
  strictEqual(hasSet32Reg(loadInstruction, "eax"), true);
  deepStrictEqual(opNames(loadInstruction.ir), [
    "get:symbolicRead",
    "set:registerMaterialization",
    "get",
    "set",
    "next"
  ]);
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax", "ebx"]);
});

test("runRegisterValuePass materializes address registers before faultable memory writes", () => {
  const movEaxEcx = ok(decodeBytes([0x89, 0xc8], startAddress));
  const movEaxPtrEbx = ok(decodeBytes([0x89, 0x18], movEaxEcx.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], movEaxPtrEbx.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([
    movEaxEcx,
    movEaxPtrEbx,
    trap
  ]));
  const storeInstruction = folded.block.instructions[1]!;

  strictEqual(folded.registerValuePropagation.removedSetCount, 1);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 1);
  strictEqual(hasSet32Reg(folded.block.instructions[0]!, "eax"), false);
  strictEqual(hasSet32Reg(storeInstruction, "eax"), true);
  strictEqual(storeInstruction.ir.some((op) => op.op === "set" && op.target.kind === "operand"), true);
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax"]);
});

test("runRegisterValuePass removes writes from a two-XCHG register round trip", () => {
  const folded = runRegisterValuePass(buildDecodedJitIrBlock([
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xc3 // xchg ebx, eax
  ]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 4);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 0);
  deepStrictEqual(setTargetRegs(folded.block.instructions), []);
});

test("runRegisterValuePass removes writes from chained XCHG register round trips", () => {
  const folded = runRegisterValuePass(buildDecodedJitIrBlock([
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xcb, // xchg ebx, ecx
    0x87, 0xc1, // xchg ecx, eax
    0x87, 0xd9 // xchg ecx, ebx
  ]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 8);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 0);
  deepStrictEqual(setTargetRegs(folded.block.instructions), []);
});

test("runRegisterValuePass materializes value-changing XCHG cycles as a register batch", () => {
  const folded = runRegisterValuePass(buildDecodedJitIrBlock([
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xcb // xchg ebx, ecx
  ]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 3);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 2);
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["eax", "ebx", "ecx"]);
  deepStrictEqual(opNames(folded.block.instructions[1]!.ir), [
    "get:symbolicRead",
    "get",
    "get:symbolicRead",
    "set:registerMaterialization",
    "set:registerMaterialization",
    "set",
    "next"
  ]);
});

test("runRegisterValuePass resumes after the last pre-instruction exit in an instruction", () => {
  const pushEax = ok(decodeBytes([0x50], startAddress));
  const trap = ok(decodeBytes([0xcd, 0x2e], pushEax.nextEip));
  const folded = runRegisterValuePass(buildJitIrBlock([pushEax, trap]));

  strictEqual(folded.registerValuePropagation.removedSetCount, 1);
  strictEqual(folded.registerValuePropagation.materializedSetCount, 1);
  strictEqual(
    folded.block.instructions[0]!.ir.some((op) => op.op === "set" && op.target.kind === "reg" && op.target.reg === "esp"),
    false
  );
  deepStrictEqual(setTargetRegs(folded.block.instructions), ["esp"]);
});

function buildDecodedJitIrBlock(bytes: readonly number[]): JitIrBlock {
  const instructions: Parameters<typeof buildJitIrBlock>[0][number][] = [];
  let offset = 0;
  let eip = startAddress;

  while (offset < bytes.length) {
    const decoded = ok(decodeBytes(bytes.slice(offset), eip));

    instructions.push(decoded);
    offset += decoded.nextEip - eip;
    eip = decoded.nextEip;
  }

  return buildJitIrBlock(instructions);
}

function hasSet32Reg(
  instruction: JitIrBlockInstruction,
  reg: Reg32
): boolean {
  return instruction.ir.some((op) =>
    op.op === "set" &&
    op.target.kind === "reg" &&
    op.target.reg === reg
  );
}

function opNames(ops: readonly { op: string; operator?: string; role?: string }[]): readonly string[] {
  return ops.map((op) => {
    if (op.role !== undefined) {
      return `${op.op}:${op.role}`;
    }

    return op.operator === undefined ? op.op : `${op.op}:${op.operator}`;
  });
}
