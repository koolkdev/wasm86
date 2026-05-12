import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import type { StorageRef, ValueRef } from "#x86/ir/model/types.js";
import { createCpuState, getFlag } from "#x86/state/cpu-state.js";
import { stateOffset, wasmMemoryIndex } from "#backends/wasm/abi.js";
import { wasmOpcode, wasmSectionId } from "#backends/wasm/encoder/types.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { buildJitIrBlock, encodeJitIrBlock } from "#backends/wasm/jit/block.js";
import { irOpDst, irOpIsTerminator } from "#x86/ir/model/op-semantics.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import { planJitCodegen } from "#backends/wasm/jit/codegen/plan/plan.js";
import { optimizeJitIrBlock } from "#backends/wasm/jit/optimization/optimize.js";
import type { JitIrOp } from "#backends/wasm/jit/ir/types.js";
import { runJitIrBlock } from "./helpers.js";

const startAddress = 0x1000;
const preservedEflags = 0xffff_0000;
const allArithmeticEflags = 0x8d5;
const zeroFlag = 1 << 6;
const addWraparoundEflags = 0x55;
const subBorrowEflags = 0x95;
const zeroResultEflags = 0x44;

test("buildJitIrBlock builds instruction-local IR bodies", () => {
  const first = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const second = ok(decodeBytes([0x83, 0xc0, 0x01], first.nextEip));
  const block = buildJitIrBlock([first, second]);
  const firstIr = block.instructions[0]!.ir;
  const secondIr = block.instructions[1]!.ir;
  const firstDefIds = firstIr.flatMap(irOpDstId);
  const secondDefIds = secondIr.flatMap(irOpDstId);

  strictEqual("ir" in block, false);
  strictEqual("operands" in block, false);
  strictEqual(block.instructions.length, 2);
  strictEqual(block.instructions[0]!.operands.length, first.operands.length);
  strictEqual(block.instructions[1]!.operands.length, second.operands.length);
  strictEqual(firstIr.filter((op) => op.op === "next").length, 1);
  strictEqual(secondIr.filter((op) => op.op === "next").length, 1);
  deepStrictEqual([...new Set(firstIr.flatMap(irOpOperandIndexes))].sort((a, b) => a - b), [0, 1]);
  deepStrictEqual([...new Set(secondIr.flatMap(irOpOperandIndexes))].sort((a, b) => a - b), [0, 1]);
  strictEqual(new Set(firstDefIds).size, firstDefIds.length);
  strictEqual(new Set(secondDefIds).size, secondDefIds.length);
  strictEqual(Math.min(...secondDefIds), 0);
});

test("JIT codegen plan keeps instruction-local operand namespaces", () => {
  const first = ok(decodeBytes([0x89, 0x18], startAddress));
  const second = ok(decodeBytes([0x89, 0x11], first.nextEip));
  const optimizedBlock = optimizeJitIrBlock(buildJitIrBlock([first, second]));
  const codegenPlan = planJitCodegen(optimizedBlock);
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const firstIr = optimizedBlock.instructions[0]!.ir;
  const secondIr = optimizedBlock.instructions[1]!.ir;

  strictEqual("ir" in optimizedBlock, false);
  strictEqual("operands" in optimizedBlock, false);
  strictEqual(emissionPlan.instructions.length, 2);
  strictEqual(firstIr.filter(irOpIsTerminator).length, 1);
  strictEqual(secondIr.filter(irOpIsTerminator).length, 1);
  deepStrictEqual([...new Set(firstIr.flatMap(irOpOperandIndexes))].sort((a, b) => a - b), [0, 1]);
  deepStrictEqual([...new Set(secondIr.flatMap(irOpOperandIndexes))].sort((a, b) => a - b), [0, 1]);
});

test("buildJitIrBlock lowers unary ALU forms with preserved widths", () => {
  const notIr = buildJitIrBlock([ok(decodeBytes([0x66, 0xf7, 0xd0], startAddress))])
    .instructions[0]!.ir;
  const negIr = buildJitIrBlock([ok(decodeBytes([0xf6, 0xd8], startAddress))])
    .instructions[0]!.ir;
  const notSet = notIr.find((op) => op.op === "set");
  const negFlags = negIr.find((op) => op.op === "flags.set");

  strictEqual(notIr.some((op) => op.op === "value.binary" && op.operator === "xor"), true);
  strictEqual(notIr.some((op) => op.op === "flags.set"), false);
  strictEqual(notSet?.op === "set" ? notSet.accessWidth : undefined, 16);

  strictEqual(negIr.some((op) => op.op === "value.binary" && op.operator === "sub"), true);
  strictEqual(negFlags?.op === "flags.set" ? negFlags.producer : undefined, "sub");
  strictEqual(negFlags?.op === "flags.set" ? negFlags.width : undefined, 8);
});

test("buildJitIrBlock prunes flag producers overwritten inside the block", () => {
  const cmp = ok(decodeBytes([0x39, 0xd8], startAddress));
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], cmp.nextEip));
  const ir = codegenIr(buildJitIrBlock([cmp, add]));
  const flagSets = ir.filter((op) => op.op === "flags.set");

  deepStrictEqual(flagSets.map((op) => op.op === "flags.set" ? op.producer : undefined), ["add"]);
});

test("buildJitIrBlock leaves condition materialization to JIT flag state", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const jz = ok(decodeBytes([0x74, 0x05], add.nextEip));
  const branchBlock = optimizeJitIrBlock(buildJitIrBlock([add, jz]));
  const branchIr = blockIr(branchBlock);
  const conditionalJumpOpIndex = branchBlock.instructions[1]!.ir.findIndex((op) => op.op === "conditionalJump");

  strictEqual(conditionalJumpOpIndex !== -1, true);
  strictEqual(branchIr.some((op) => op.op === "flags.condition"), true);

  const trap = ok(decodeBytes([0xcd, 0x2e], add.nextEip));
  const exitBlock = optimizeJitIrBlock(buildJitIrBlock([add, trap]));
  const hostTrapOpIndex = exitBlock.instructions[1]!.ir.findIndex((op) => op.op === "hostTrap");

  strictEqual(hostTrapOpIndex !== -1, true);
});

test("buildJitIrBlock keeps earlier CF producer live across INC", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const inc = ok(decodeBytes([0x40], add.nextEip));
  const jc = ok(decodeBytes([0x72, 0x05], inc.nextEip));
  const ir = codegenIr(buildJitIrBlock([add, inc, jc]));
  const flagSets = ir.filter((op) => op.op === "flags.set");

  deepStrictEqual(flagSets.map((op) => op.op === "flags.set" ? op.producer : undefined), ["add", "inc"]);
});

test("buildJitIrBlock keeps cmp and jcc branch conditions in flag value state", () => {
  const cmp = ok(decodeBytes([0x39, 0xd8], startAddress));
  const je = ok(decodeBytes([0x74, 0x05], cmp.nextEip));
  const ir = codegenIr(buildJitIrBlock([cmp, je]));

  strictEqual(ir.some((op) => op.op === "flags.condition"), true);
});

test("buildJitIrBlock does not specialize incoming CF after INC", () => {
  const inc = ok(decodeBytes([0x40], startAddress));
  const jc = ok(decodeBytes([0x72, 0x05], inc.nextEip));
  const block = buildJitIrBlock([inc, jc]);

  deepStrictEqual(aluFlagMemoryAccessCounts(block), { loads: 3, stores: 2 });
});

test("jit IR block emits aluFlags memory traffic only for flag reads and observable exits", () => {
  const flagFreeBlock = buildJitIrBlock([
    ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress)),
    ok(decodeBytes([0xbb, 0x02, 0x00, 0x00, 0x00], startAddress + 5)),
    ok(decodeBytes([0xcd, 0x2e], startAddress + 10))
  ]);
  const branchBlock = buildJitIrBlock([ok(decodeBytes([0x74, 0x05], startAddress))]);
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const jnzAfterAdd = ok(decodeBytes([0x75, 0x05], add.nextEip));
  const branchAfterAddBlock = buildJitIrBlock([add, jnzAfterAdd]);
  const addTrapBlock = buildJitIrBlock([add, ok(decodeBytes([0xcd, 0x2e], add.nextEip))]);

  deepStrictEqual(aluFlagMemoryAccessCounts(flagFreeBlock), { loads: 0, stores: 0 });
  deepStrictEqual(aluFlagMemoryAccessCounts(branchBlock), { loads: 1, stores: 0 });
  deepStrictEqual(stateMemoryLoads(branchBlock).slice(0, 2), [
    stateOffset.instructionCount,
    stateOffset.aluFlags
  ]);
  deepStrictEqual(aluFlagMemoryAccessCounts(branchAfterAddBlock), { loads: 0, stores: 2 });
  deepStrictEqual(aluFlagMemoryAccessCounts(addTrapBlock), { loads: 0, stores: 1 });
});

test("jit IR block emits mov r32, imm32 with static operands", async () => {
  const result = await runJitIrBlock([0xb8, 0x78, 0x56, 0x34, 0x12], createCpuState({ eip: startAddress }));

  strictEqual(result.state.eax, 0x1234_5678);
  strictEqual(result.state.eip, startAddress + 5);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 5 });
});

test("jit IR block continues through fallthrough instructions until a control exit", async () => {
  const result = await runJitIrBlock(
    [
      0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
      0x83, 0xc0, 0x01, // add eax, 1
      0x83, 0xc0, 0x01, // add eax, 1
      0xcd, 0x2e // int 0x2e
    ],
    createCpuState({ eip: startAddress })
  );

  strictEqual(result.state.eax, 3);
  strictEqual(result.state.eip, startAddress + 13);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block emits memory mov with static effective addresses", async () => {
  const load = await runJitIrBlock(
    [0x8b, 0x43, 0x04],
    createCpuState({ ebx: 0x2000, eip: startAddress }),
    [{ address: 0x2004, bytes: [0x78, 0x56, 0x34, 0x12] }]
  );

  strictEqual(load.state.eax, 0x1234_5678);

  const store = await runJitIrBlock(
    [0x89, 0x43, 0x08],
    createCpuState({ eax: 0xaabb_ccdd, ebx: 0x2000, eip: startAddress })
  );

  strictEqual(store.guestView.getUint32(0x2008, true), 0xaabb_ccdd);

  const storeImmediate = await runJitIrBlock(
    [0xc7, 0x43, 0x0c, 0x78, 0x56, 0x34, 0x12],
    createCpuState({ ebx: 0x2000, eip: startAddress })
  );

  strictEqual(storeImmediate.guestView.getUint32(0x200c, true), 0x1234_5678);
});

test("jit IR block handles partial register MOV writes", async () => {
  const movAl = await runJitIrBlock([0xb0, 0x44], createCpuState({
    eax: 0x1122_3300,
    eip: startAddress
  }));
  const movAh = await runJitIrBlock([0xb4, 0x55], createCpuState({
    eax: 0x1122_0033,
    eip: startAddress
  }));
  const movAx = await runJitIrBlock([0x66, 0xb8, 0x78, 0x56], createCpuState({
    eax: 0x1234_0000,
    eip: startAddress
  }));

  strictEqual(movAl.state.eax, 0x1122_3344);
  strictEqual(movAh.state.eax, 0x1122_5533);
  strictEqual(movAx.state.eax, 0x1234_5678);
});

test("jit IR block emits register-only xchg forms after reading both operands", async () => {
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    initial: ReturnType<typeof createCpuState>;
    expected: Pick<ReturnType<typeof createCpuState>, "eax" | "ebx" | "eflags">;
  }>[] = [
    {
      name: "xchg eax, ebx",
      bytes: [0x87, 0xd8],
      initial: createCpuState({
        eax: 0x1111_1111,
        ebx: 0x2222_2222,
        eflags: preservedEflags,
        eip: startAddress
      }),
      expected: { eax: 0x2222_2222, ebx: 0x1111_1111, eflags: preservedEflags }
    },
    {
      name: "xchg al, bl",
      bytes: [0x86, 0xd8],
      initial: createCpuState({
        eax: 0x1234_5678,
        ebx: 0xaabb_ccdd,
        eflags: preservedEflags,
        eip: startAddress
      }),
      expected: { eax: 0x1234_56dd, ebx: 0xaabb_cc78, eflags: preservedEflags }
    },
    {
      name: "xchg ax, bx",
      bytes: [0x66, 0x87, 0xd8],
      initial: createCpuState({
        eax: 0x1234_5678,
        ebx: 0xaabb_ccdd,
        eflags: preservedEflags,
        eip: startAddress
      }),
      expected: { eax: 0x1234_ccdd, ebx: 0xaabb_5678, eflags: preservedEflags }
    },
    {
      name: "xchg al, ah",
      bytes: [0x86, 0xe0],
      initial: createCpuState({
        eax: 0x1234_5678,
        ebx: 0xaabb_ccdd,
        eflags: preservedEflags,
        eip: startAddress
      }),
      expected: { eax: 0x1234_7856, ebx: 0xaabb_ccdd, eflags: preservedEflags }
    }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(entry.bytes, entry.initial);

    strictEqual(result.state.eax, entry.expected.eax, entry.name);
    strictEqual(result.state.ebx, entry.expected.ebx, entry.name);
    strictEqual(result.state.eflags, entry.expected.eflags, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + entry.bytes.length });
  }
});

test("jit IR block snapshots xchg-style parallel exit stores before state writes", async () => {
  const result = await runJitIrBlock([
    0x87, 0xd8, // xchg eax, ebx
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x2222_2222);
  strictEqual(result.state.ebx, 0x1111_1111);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 4);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block emits same-register xchg forms as flagless no-ops", async () => {
  const cases: readonly Readonly<{ name: string; bytes: readonly number[] }>[] = [
    { name: "xchg eax, eax", bytes: [0x87, 0xc0] },
    { name: "xchg ax, ax", bytes: [0x66, 0x87, 0xc0] },
    { name: "xchg al, al", bytes: [0x86, 0xc0] },
    { name: "xchg ah, ah", bytes: [0x86, 0xe4] }
  ];

  for (const entry of cases) {
    const initial = createCpuState({
      eax: 0x1234_5678,
      ebx: 0xaabb_ccdd,
      eflags: preservedEflags,
      eip: startAddress
    });
    const result = await runJitIrBlock(entry.bytes, initial);

    strictEqual(result.state.eax, initial.eax, entry.name);
    strictEqual(result.state.ebx, initial.ebx, entry.name);
    strictEqual(result.state.eflags, preservedEflags, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
  }
});

test("jit IR block emits memory xchg forms after reading memory and register operands", async () => {
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    width: 8 | 16 | 32;
    initial: ReturnType<typeof createCpuState>;
    memoryValue: number;
    expected: Pick<ReturnType<typeof createCpuState>, "eax" | "ebx" | "eflags">;
    expectedMemoryValue: number;
  }>[] = [
    {
      name: "xchg [eax], ebx",
      bytes: [0x87, 0x18],
      width: 32,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: preservedEflags, eip: startAddress }),
      memoryValue: 0x1122_3344,
      expected: { eax: 0x20, ebx: 0x1122_3344, eflags: preservedEflags },
      expectedMemoryValue: 0xaabb_ccdd
    },
    {
      name: "xchg [eax], bl",
      bytes: [0x86, 0x18],
      width: 8,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: preservedEflags, eip: startAddress }),
      memoryValue: 0x78,
      expected: { eax: 0x20, ebx: 0xaabb_cc78, eflags: preservedEflags },
      expectedMemoryValue: 0xdd
    },
    {
      name: "xchg [eax], bx",
      bytes: [0x66, 0x87, 0x18],
      width: 16,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: preservedEflags, eip: startAddress }),
      memoryValue: 0x1357,
      expected: { eax: 0x20, ebx: 0xaabb_1357, eflags: preservedEflags },
      expectedMemoryValue: 0xccdd
    }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(
      entry.bytes,
      entry.initial,
      [{ address: entry.initial.eax, bytes: littleEndianBytes(entry.memoryValue, entry.width) }]
    );

    strictEqual(result.state.eax, entry.expected.eax, entry.name);
    strictEqual(result.state.ebx, entry.expected.ebx, entry.name);
    strictEqual(result.state.eflags, entry.expected.eflags, entry.name);
    strictEqual(readGuestValue(result.guestView, entry.initial.eax, entry.width), entry.expectedMemoryValue, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + entry.bytes.length });
  }
});

test("jit IR block exits on XCHG memory read fault before changing registers", async () => {
  const initial = createCpuState({
    eax: 0x1_0000,
    ebx: 0x2222_2222,
    eflags: preservedEflags,
    eip: startAddress,
    instructionCount: 7
  });
  const result = await runJitIrBlock([0x87, 0x18], initial);

  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x1_0000, detail: 4 });
  strictEqual(result.state.eax, initial.eax);
  strictEqual(result.state.ebx, initial.ebx);
  strictEqual(result.state.eflags, initial.eflags);
  strictEqual(result.state.eip, initial.eip);
  strictEqual(result.state.instructionCount, initial.instructionCount);
});

test("jit register value propagation preserves XCHG swap ordering for tracked values", async () => {
  const bytes = [
    0xb8, 0x11, 0x11, 0x11, 0x11, // mov eax, 0x11111111
    0xbb, 0x22, 0x22, 0x22, 0x22, // mov ebx, 0x22222222
    0x87, 0xd8 // xchg eax, ebx
  ];
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0,
    ebx: 0,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x2222_2222);
  strictEqual(result.state.ebx, 0x1111_1111);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit register value propagation preserves chained XCHG register cycles", async () => {
  const bytes = [
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xcb, // xchg ebx, ecx
    0x87, 0xc1, // xchg ecx, eax
    0x87, 0xd9 // xchg ecx, ebx
  ];
  const initial = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    ecx: 0x3333_3333,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, initial.eax);
  strictEqual(result.state.ebx, initial.ebx);
  strictEqual(result.state.ecx, initial.ecx);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit register value propagation preserves value-changing XCHG register cycles", async () => {
  const bytes = [
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xcb // xchg ebx, ecx
  ];
  const initial = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    ecx: 0x3333_3333,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, initial.ebx);
  strictEqual(result.state.ebx, initial.ecx);
  strictEqual(result.state.ecx, initial.eax);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit Wasm register state preserves a chained XCHG register cycle", async () => {
  const bytes = [
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xcb // xchg ebx, ecx
  ];
  const initial = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    ecx: 0x3333_3333,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, initial.ebx);
  strictEqual(result.state.ebx, initial.ecx);
  strictEqual(result.state.ecx, initial.eax);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit register value propagation materializes XCHG state before later memory faults", async () => {
  const bytes = [
    0x87, 0xd8, // xchg eax, ebx
    0x8b, 0x15, 0x00, 0x00, 0x01, 0x00, // mov edx, [0x10000]
    0x87, 0xd8 // xchg eax, ebx
  ];
  const initial = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    edx: 0x3333_3333,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, initial.ebx);
  strictEqual(result.state.ebx, initial.eax);
  strictEqual(result.state.edx, initial.edx);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x1_0000, detail: 4 });
});

test("jit register value propagation keeps partial XCHG before full XCHG conservative", async () => {
  const bytes = [
    0x86, 0xd8, // xchg al, bl
    0x87, 0xd8 // xchg eax, ebx
  ];
  const initial = createCpuState({
    eax: 0x1111_11aa,
    ebx: 0x2222_22bb,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, 0x2222_22aa);
  strictEqual(result.state.ebx, 0x1111_11bb);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block emits movzx and movsx without modifying flags", async () => {
  const movzxByte = await runJitIrBlock([0x0f, 0xb6, 0xc7], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 0x1234_807f,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const movsxByte = await runJitIrBlock([0x0f, 0xbe, 0xcf], createCpuState({
    ebx: 0x1234_807f,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const movzxWordDestination = await runJitIrBlock([0x66, 0x0f, 0xb6, 0xc3], createCpuState({
    eax: 0x1234_0000,
    ebx: 0x80,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const movsxWordDestination = await runJitIrBlock([0x66, 0x0f, 0xbe, 0xc3], createCpuState({
    eax: 0x1234_0000,
    ebx: 0x80,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(movzxByte.state.eax, 0x80);
  strictEqual(movzxByte.state.eflags, preservedEflags);
  strictEqual(movzxByte.state.eip, startAddress + 3);
  strictEqual(movzxByte.state.instructionCount, 1);

  strictEqual(movsxByte.state.ecx, 0xffff_ff80);
  strictEqual(movsxByte.state.eflags, preservedEflags);
  strictEqual(movsxByte.state.eip, startAddress + 3);
  strictEqual(movsxByte.state.instructionCount, 1);

  strictEqual(movzxWordDestination.state.eax, 0x1234_0080);
  strictEqual(movzxWordDestination.state.eflags, preservedEflags);
  strictEqual(movzxWordDestination.state.eip, startAddress + 4);
  strictEqual(movzxWordDestination.state.instructionCount, 1);

  strictEqual(movsxWordDestination.state.eax, 0x1234_ff80);
  strictEqual(movsxWordDestination.state.eflags, preservedEflags);
  strictEqual(movsxWordDestination.state.eip, startAddress + 4);
  strictEqual(movsxWordDestination.state.instructionCount, 1);
});

test("jit IR block preserves MOVSX r16 result across BL/BX/EBX alias operations", async () => {
  const bytes = [
    0x66, 0x0f, 0xbe, 0xd8, // movsx bx, al
    0x80, 0xc3, 0x01, // add bl, 1
    0x66, 0x83, 0xc3, 0x01, // add bx, 1
    0x83, 0xc3, 0x01 // add ebx, 1
  ];
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x80,
    ebx: 0x1122_3344,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x80);
  strictEqual(result.state.ebx, 0x1122_ff83);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block sign-extends a tracked partial MOV value", async () => {
  const bytes = [
    0x66, 0x89, 0xd8, // mov ax, bx
    0x0f, 0xbf, 0xc8 // movsx ecx, ax
  ];
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x1234_0000,
    ebx: 0x0000_8001,
    ecx: 0xcccc_cccc,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_8001);
  strictEqual(result.state.ebx, 0x0000_8001);
  strictEqual(result.state.ecx, 0xffff_8001);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block emits movzx and movsx memory forms", async () => {
  const movzxByte = await runJitIrBlock(
    [0x0f, 0xb6, 0x03],
    createCpuState({ eax: 0xffff_ffff, ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0xfe] }]
  );
  const movzxWord = await runJitIrBlock(
    [0x0f, 0xb7, 0x03],
    createCpuState({ eax: 0xffff_ffff, ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0xff, 0x80] }]
  );
  const movsxByte = await runJitIrBlock(
    [0x0f, 0xbe, 0x03],
    createCpuState({ ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0x80] }]
  );
  const movsxWord = await runJitIrBlock(
    [0x0f, 0xbf, 0x03],
    createCpuState({ ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0x01, 0x80] }]
  );

  strictEqual(movzxByte.state.eax, 0xfe);
  strictEqual(movzxByte.state.eflags, preservedEflags);
  strictEqual(movzxByte.state.eip, startAddress + 3);
  strictEqual(movzxByte.state.instructionCount, 1);

  strictEqual(movzxWord.state.eax, 0x80ff);
  strictEqual(movzxWord.state.eflags, preservedEflags);
  strictEqual(movzxWord.state.eip, startAddress + 3);
  strictEqual(movzxWord.state.instructionCount, 1);

  strictEqual(movsxByte.state.eax, 0xffff_ff80);
  strictEqual(movsxByte.state.eflags, preservedEflags);
  strictEqual(movsxByte.state.eip, startAddress + 3);
  strictEqual(movsxByte.state.instructionCount, 1);

  strictEqual(movsxWord.state.eax, 0xffff_8001);
  strictEqual(movsxWord.state.eflags, preservedEflags);
  strictEqual(movsxWord.state.eip, startAddress + 3);
  strictEqual(movsxWord.state.instructionCount, 1);
});

test("jit IR block coalesces independent low-byte register writes correctly", async () => {
  const result = await runJitIrBlock([
    0xb0, 0x05, // mov al, 5
    0xb4, 0x05 // mov ah, 5
  ], createCpuState({
    eax: 0x1122_3300,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1122_0505);
  strictEqual(result.state.eip, startAddress + 4);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 4 });
});

test("jit IR block materializes partial register writes before full-register copies", async () => {
  const result = await runJitIrBlock([
    0xb0, 0x05, // mov al, 5
    0x89, 0xc3 // mov ebx, eax
  ], createCpuState({
    eax: 0x1122_3300,
    ebx: 0xcccc_cccc,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1122_3305);
  strictEqual(result.state.ebx, 0x1122_3305);
  strictEqual(result.state.eip, startAddress + 4);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 4 });
});

test("jit IR block composes AX then AL through planned exit store sources", async () => {
  const instructionBytes = [
    [0x66, 0x89, 0xc8], // mov ax, cx
    [0x88, 0xd0], // mov al, dl
    [0xcd, 0x2e] // int 0x2e
  ];
  const block = decodedBlock(instructionBytes);
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0xaaaa_0000,
    ecx: 0xbbbb_1234,
    edx: 0xcccc_cc56,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xaaaa_1256);
  // The current generic exit-store path rebuilds the full register for this
  // composed source instead of preserving the narrower store shape.
  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Store, offset: stateOffset.eax }
  ]);
});

test("jit IR block composes EAX then AL without loading EAX from CPU state", async () => {
  const instructionBytes = [
    [0x89, 0xc8], // mov eax, ecx
    [0x88, 0xd0], // mov al, dl
    [0xcd, 0x2e] // int 0x2e
  ];
  const block = decodedBlock(instructionBytes);
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0xaaaa_aaaa,
    ecx: 0xbbbb_1234,
    edx: 0xcccc_cc56,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xbbbb_1256);
  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Store, offset: stateOffset.eax }
  ]);
});

test("jit IR block captures produced root exit stores without rematerializing the load", async () => {
  const instructionBytes = [
    [0x8b, 0x05, 0x60, 0x00, 0x00, 0x00], // mov eax, [0x60]
    [0xcd, 0x2e] // int 0x2e
  ];
  const block = decodedBlock(instructionBytes);
  const guestLoads = memoryAccesses(extractOnlyFunctionBody(encodeJitIrBlock([block])))
    .filter((access) => access.memoryIndex === wasmMemoryIndex.guest && access.opcode === wasmOpcode.i32Load);
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0,
    eip: startAddress
  }), [{ address: 0x60, bytes: littleEndianBytes(0x1234_5678, 32) }]);

  strictEqual(guestLoads.length, 1);
  strictEqual(result.state.eax, 0x1234_5678);
  strictEqual(result.state.eip, startAddress + 8);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block composes EAX then AX without loading EAX from CPU state", async () => {
  const instructionBytes = [
    [0x89, 0xc8], // mov eax, ecx
    [0x66, 0x89, 0xd0], // mov ax, dx
    [0xcd, 0x2e] // int 0x2e
  ];
  const block = decodedBlock(instructionBytes);
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0xaaaa_aaaa,
    ecx: 0xbbbb_1234,
    edx: 0xcccc_5678,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xbbbb_5678);
  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Store, offset: stateOffset.eax }
  ]);
});

test("jit IR block keeps AX then AH correct through mutable fallback", async () => {
  const result = await runJitIrBlock([
    0x66, 0x89, 0xc8, // mov ax, cx
    0x88, 0xd4, // mov ah, dl
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_0000,
    ecx: 0xbbbb_1234,
    edx: 0xcccc_cc56,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xaaaa_5634);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block exit stores AL and AX immediates without full EAX loads", async () => {
  const alBytes = [[0xb0, 0x34], [0xcd, 0x2e]]; // mov al, 0x34; int 0x2e
  const axBytes = [[0x66, 0xb8, 0x34, 0x12], [0xcd, 0x2e]]; // mov ax, 0x1234; int 0x2e
  const alBlock = decodedBlock(alBytes);
  const axBlock = decodedBlock(axBytes);
  const alResult = await runJitIrBlock(alBytes.flat(), createCpuState({ eax: 0xaaaa_aa00, eip: startAddress }));
  const axResult = await runJitIrBlock(axBytes.flat(), createCpuState({ eax: 0xaaaa_0000, eip: startAddress }));

  strictEqual(alResult.state.eax, 0xaaaa_aa34);
  strictEqual(axResult.state.eax, 0xaaaa_1234);
  deepStrictEqual(registerStateMemoryAccesses(alBlock, stateOffset.eax), [
    { opcode: wasmOpcode.i32Store8, offset: stateOffset.eax }
  ]);
  deepStrictEqual(registerStateMemoryAccesses(axBlock, stateOffset.eax), [
    { opcode: wasmOpcode.i32Store16, offset: stateOffset.eax }
  ]);
});

test("jit IR block keeps AX prefix semantics when a full read also occurs", async () => {
  const instructionBytes = [
    [0x66, 0xb8, 0x34, 0x12], // mov ax, 0x1234
    [0x89, 0xc3], // mov ebx, eax
    [0xcd, 0x2e] // int 0x2e
  ];
  const block = decodedBlock(instructionBytes);
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0xaaaa_0000,
    ebx: 0xbbbb_bbbb,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xaaaa_1234);
  strictEqual(result.state.ebx, 0xaaaa_1234);
  // The current generic exit-store path emits an additional narrow writeback for
  // this planned EAX store source.
  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Store16, offset: stateOffset.eax }
  ]);
});

test("jit IR block reads known partial register prefixes across instructions", async () => {
  const result = await runJitIrBlock([
    0xb0, 0x78, // mov al, 0x78
    0x88, 0xc3, // mov bl, al
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aa00,
    ebx: 0xbbbb_bb00,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xaaaa_aa78);
  strictEqual(result.state.ebx, 0xbbbb_bb78);
  strictEqual(result.state.eip, startAddress + 6);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block preserves al, ax, and ah reads from tracked full registers", async () => {
  const al = await runJitIrBlock([
    0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
    0x88, 0xc3, // mov bl, al
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0xaaaa_aa00,
    eip: startAddress
  }));
  const ax = await runJitIrBlock([
    0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
    0x66, 0x89, 0xc3, // mov bx, ax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0xaaaa_0000,
    eip: startAddress
  }));
  const ah = await runJitIrBlock([
    0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
    0x88, 0xe3, // mov bl, ah
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0xbbbb_bb00,
    eip: startAddress
  }));

  strictEqual(al.state.eax, 0x1234_5678);
  strictEqual(al.state.ebx, 0xaaaa_aa78);
  strictEqual(al.state.eip, startAddress + 9);
  strictEqual(al.state.instructionCount, 3);
  deepStrictEqual(al.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(ax.state.eax, 0x1234_5678);
  strictEqual(ax.state.ebx, 0xaaaa_5678);
  strictEqual(ax.state.eip, startAddress + 10);
  strictEqual(ax.state.instructionCount, 3);
  deepStrictEqual(ax.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(ah.state.eax, 0x1234_5678);
  strictEqual(ah.state.ebx, 0xbbbb_bb56);
  strictEqual(ah.state.eip, startAddress + 9);
  strictEqual(ah.state.instructionCount, 3);
  deepStrictEqual(ah.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block preserves mixed al, ah, ax, and eax alias interactions", async () => {
  const alAhToAx = await runJitIrBlock([
    0xb0, 0x34, // mov al, 0x34
    0xb4, 0x12, // mov ah, 0x12
    0x66, 0x89, 0xc3, // mov bx, ax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0,
    eip: startAddress
  }));
  const axToAh = await runJitIrBlock([
    0x66, 0xb8, 0x34, 0x12, // mov ax, 0x1234
    0x88, 0xe3, // mov bl, ah
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0,
    eip: startAddress
  }));
  const alToAxPreservesAh = await runJitIrBlock([
    0xb0, 0x34, // mov al, 0x34
    0x66, 0x89, 0xc3, // mov bx, ax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_1200,
    ebx: 0,
    eip: startAddress
  }));
  const fullAfterPartial = await runJitIrBlock([
    0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
    0xb0, 0xaa, // mov al, 0xaa
    0x89, 0xc3, // mov ebx, eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0,
    eip: startAddress
  }));

  strictEqual(alAhToAx.state.eax, 0x1234);
  strictEqual(alAhToAx.state.ebx, 0x1234);
  strictEqual(alAhToAx.state.eip, startAddress + 9);
  strictEqual(alAhToAx.state.instructionCount, 4);
  deepStrictEqual(alAhToAx.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(axToAh.state.eax, 0x1234);
  strictEqual(axToAh.state.ebx, 0x12);
  strictEqual(axToAh.state.eip, startAddress + 8);
  strictEqual(axToAh.state.instructionCount, 3);
  deepStrictEqual(axToAh.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(alToAxPreservesAh.state.eax, 0xaaaa_1234);
  strictEqual(alToAxPreservesAh.state.ebx, 0x1234);
  strictEqual(alToAxPreservesAh.state.eip, startAddress + 7);
  strictEqual(alToAxPreservesAh.state.instructionCount, 3);
  deepStrictEqual(alToAxPreservesAh.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(fullAfterPartial.state.eax, 0x1234_56aa);
  strictEqual(fullAfterPartial.state.ebx, 0x1234_56aa);
  strictEqual(fullAfterPartial.state.eip, startAddress + 11);
  strictEqual(fullAfterPartial.state.instructionCount, 4);
  deepStrictEqual(fullAfterPartial.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block handles byte and word memory MOV accesses", async () => {
  const byteStore = await runJitIrBlock([0x88, 0x03], createCpuState({
    eax: 0xaabb_ccdd,
    ebx: 0x40,
    eip: startAddress
  }));
  const wordLoad = await runJitIrBlock(
    [0x66, 0x8b, 0x03],
    createCpuState({
      eax: 0xffff_0000,
      ebx: 0x40,
      eip: startAddress
    }),
    [{ address: 0x40, bytes: [0x34, 0x12] }]
  );
  const wordStore = await runJitIrBlock([0x66, 0x89, 0x03], createCpuState({
    eax: 0xaaaa_babe,
    ebx: 0x44,
    eip: startAddress
  }));

  strictEqual(byteStore.guestView.getUint8(0x40), 0xdd);
  strictEqual(wordLoad.state.eax, 0xffff_1234);
  strictEqual(wordStore.guestView.getUint16(0x44, true), 0xbabe);
  strictEqual(wordStore.guestView.getUint8(0x46), 0);
});

test("jit IR block handles partial-width ALU register writeback", async () => {
  const result = await runJitIrBlock([0x04, 0x01], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xffff_ff00);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block keeps partial-width immediate ALU inside the destination alias", async () => {
  const cases = [
    {
      name: "ADD AX wraps at 16 bits",
      bytes: [0x66, 0x05, 0xff, 0xff],
      eax: 0xffff_0001,
      expectedEax: 0xffff_0000,
      expectedEflags: addWraparoundEflags
    },
    {
      name: "ADD AX does not carry into high EAX",
      bytes: [0x66, 0x05, 0x01, 0x00],
      eax: 0x1234_ffff,
      expectedEax: 0x1234_0000,
      expectedEflags: addWraparoundEflags
    },
    {
      name: "SUB AX does not borrow from high EAX",
      bytes: [0x66, 0x2d, 0x01, 0x00],
      eax: 0x1234_0000,
      expectedEax: 0x1234_ffff,
      expectedEflags: subBorrowEflags
    },
    {
      name: "ADD AL does not carry into high EAX",
      bytes: [0x04, 0x01],
      eax: 0xffff_00ff,
      expectedEax: 0xffff_0000,
      expectedEflags: addWraparoundEflags
    },
    {
      name: "SUB AL does not borrow from high EAX",
      bytes: [0x2c, 0x01],
      eax: 0xffff_0000,
      expectedEax: 0xffff_00ff,
      expectedEflags: subBorrowEflags
    }
  ] as const;

  for (const testCase of cases) {
    const result = await runJitIrBlock(testCase.bytes, createCpuState({
      eax: testCase.eax,
      eflags: preservedEflags,
      eip: startAddress
    }));

    strictEqual(result.state.eax, testCase.expectedEax, testCase.name);
    strictEqual(result.state.eflags, (preservedEflags | testCase.expectedEflags) >>> 0, testCase.name);
    strictEqual(result.state.eip, startAddress + testCase.bytes.length, testCase.name);
    strictEqual(result.state.instructionCount, 1, testCase.name);
  }
});

test("jit IR block emits NOT register and memory forms without changing flags", async () => {
  const initialEflags = (preservedEflags | allArithmeticEflags) >>> 0;
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    width: 8 | 16 | 32;
    eax: number;
    expectedEax: number;
    memoryValue?: number;
    expectedMemoryValue?: number;
  }>[] = [
    {
      name: "NOT AL",
      bytes: [0xf6, 0xd0],
      width: 8,
      eax: 0x1234_560f,
      expectedEax: 0x1234_56f0
    },
    {
      name: "NOT AX",
      bytes: [0x66, 0xf7, 0xd0],
      width: 16,
      eax: 0x1234_560f,
      expectedEax: 0x1234_a9f0
    },
    {
      name: "NOT EAX",
      bytes: [0xf7, 0xd0],
      width: 32,
      eax: 0x1234_560f,
      expectedEax: 0xedcb_a9f0
    },
    {
      name: "NOT byte [EAX]",
      bytes: [0xf6, 0x10],
      width: 8,
      eax: 0x40,
      expectedEax: 0x40,
      memoryValue: 0x0f,
      expectedMemoryValue: 0xf0
    },
    {
      name: "NOT word [EAX]",
      bytes: [0x66, 0xf7, 0x10],
      width: 16,
      eax: 0x44,
      expectedEax: 0x44,
      memoryValue: 0x560f,
      expectedMemoryValue: 0xa9f0
    },
    {
      name: "NOT dword [EAX]",
      bytes: [0xf7, 0x10],
      width: 32,
      eax: 0x48,
      expectedEax: 0x48,
      memoryValue: 0x1234_560f,
      expectedMemoryValue: 0xedcb_a9f0
    }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(
      entry.bytes,
      createCpuState({ eax: entry.eax, eflags: initialEflags, eip: startAddress }),
      entry.memoryValue === undefined
        ? []
        : [{ address: entry.eax, bytes: littleEndianBytes(entry.memoryValue, entry.width) }]
    );

    strictEqual(result.state.eax, entry.expectedEax, entry.name);
    strictEqual(result.state.eflags, initialEflags, entry.name);
    if (entry.expectedMemoryValue !== undefined) {
      strictEqual(readGuestValue(result.guestView, entry.eax, entry.width), entry.expectedMemoryValue, entry.name);
    }
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + entry.bytes.length });
  }
});

test("jit IR block emits NEG register flags for zero, one, min-signed, and wraparound cases", async () => {
  const zeroFlags = { CF: false, OF: false, SF: false, ZF: true, PF: true, AF: false };
  const oneFlags = { CF: true, OF: false, SF: true, ZF: false, PF: true, AF: true };
  const min8Flags = { CF: true, OF: true, SF: true, ZF: false, PF: false, AF: false };
  const minWideFlags = { CF: true, OF: true, SF: true, ZF: false, PF: true, AF: false };
  const wrapFlags = { CF: true, OF: false, SF: false, ZF: false, PF: false, AF: true };
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    initialEax: number;
    expectedEax: number;
    flags: ArithmeticFlagExpectations;
  }>[] = [
    { name: "NEG AL zero", bytes: [0xf6, 0xd8], initialEax: 0xaaaa_aa00, expectedEax: 0xaaaa_aa00, flags: zeroFlags },
    { name: "NEG AL one", bytes: [0xf6, 0xd8], initialEax: 0xaaaa_aa01, expectedEax: 0xaaaa_aaff, flags: oneFlags },
    { name: "NEG AL min-signed", bytes: [0xf6, 0xd8], initialEax: 0xaaaa_aa80, expectedEax: 0xaaaa_aa80, flags: min8Flags },
    { name: "NEG AL wraparound", bytes: [0xf6, 0xd8], initialEax: 0xaaaa_aaff, expectedEax: 0xaaaa_aa01, flags: wrapFlags },
    { name: "NEG AX zero", bytes: [0x66, 0xf7, 0xd8], initialEax: 0xaaaa_0000, expectedEax: 0xaaaa_0000, flags: zeroFlags },
    { name: "NEG AX one", bytes: [0x66, 0xf7, 0xd8], initialEax: 0xaaaa_0001, expectedEax: 0xaaaa_ffff, flags: oneFlags },
    { name: "NEG AX min-signed", bytes: [0x66, 0xf7, 0xd8], initialEax: 0xaaaa_8000, expectedEax: 0xaaaa_8000, flags: minWideFlags },
    { name: "NEG AX wraparound", bytes: [0x66, 0xf7, 0xd8], initialEax: 0xaaaa_ffff, expectedEax: 0xaaaa_0001, flags: wrapFlags },
    { name: "NEG EAX zero", bytes: [0xf7, 0xd8], initialEax: 0, expectedEax: 0, flags: zeroFlags },
    { name: "NEG EAX one", bytes: [0xf7, 0xd8], initialEax: 1, expectedEax: 0xffff_ffff, flags: oneFlags },
    { name: "NEG EAX min-signed", bytes: [0xf7, 0xd8], initialEax: 0x8000_0000, expectedEax: 0x8000_0000, flags: minWideFlags },
    { name: "NEG EAX wraparound", bytes: [0xf7, 0xd8], initialEax: 0xffff_ffff, expectedEax: 1, flags: wrapFlags }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(entry.bytes, createCpuState({
      eax: entry.initialEax,
      eflags: (preservedEflags | allArithmeticEflags) >>> 0,
      eip: startAddress
    }));
    const expectedEflags = (preservedEflags | arithmeticEflags(entry.flags)) >>> 0;

    strictEqual(result.state.eax, entry.expectedEax, entry.name);
    strictEqual(result.state.eflags, expectedEflags, entry.name);
    assertArithmeticFlags(result.state, entry.flags, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
  }
});

test("jit IR block emits NEG memory forms for byte, word, and dword operands", async () => {
  const oneFlags = { CF: true, OF: false, SF: true, ZF: false, PF: true, AF: true };
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    width: 8 | 16 | 32;
    address: number;
    expectedMemoryValue: number;
  }>[] = [
    { name: "NEG byte [EAX]", bytes: [0xf6, 0x18], width: 8, address: 0x50, expectedMemoryValue: 0xff },
    { name: "NEG word [EAX]", bytes: [0x66, 0xf7, 0x18], width: 16, address: 0x54, expectedMemoryValue: 0xffff },
    { name: "NEG dword [EAX]", bytes: [0xf7, 0x18], width: 32, address: 0x58, expectedMemoryValue: 0xffff_ffff }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(
      entry.bytes,
      createCpuState({
        eax: entry.address,
        eflags: (preservedEflags | allArithmeticEflags) >>> 0,
        eip: startAddress
      }),
      [{ address: entry.address, bytes: littleEndianBytes(1, entry.width) }]
    );

    strictEqual(result.state.eax, entry.address, entry.name);
    strictEqual(readGuestValue(result.guestView, entry.address, entry.width), entry.expectedMemoryValue, entry.name);
    strictEqual(result.state.eflags, (preservedEflags | arithmeticEflags(oneFlags)) >>> 0, entry.name);
    assertArithmeticFlags(result.state, oneFlags, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + entry.bytes.length });
  }
});

test("jit IR block preserves unary ALU flags and memory effects after value propagation", async () => {
  const oneFlags = { CF: true, OF: false, SF: true, ZF: false, PF: true, AF: true };
  const initialEflags = (preservedEflags | allArithmeticEflags) >>> 0;
  const foldedNeg = await runJitIrBlock([
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
    0xf7, 0xd8, // neg eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eflags: initialEflags,
    eip: startAddress
  }));
  const memoryNot = await runJitIrBlock([
    0xb8, 0x60, 0x00, 0x00, 0x00, // mov eax, 0x60
    0xf7, 0x10, // not dword [eax]
    0x8b, 0x18, // mov ebx, [eax]
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eflags: initialEflags,
    eip: startAddress
  }), [{ address: 0x60, bytes: littleEndianBytes(0x1234_560f, 32) }]);

  strictEqual(foldedNeg.state.eax, 0xffff_ffff);
  strictEqual(foldedNeg.state.eflags, (preservedEflags | arithmeticEflags(oneFlags)) >>> 0);
  assertArithmeticFlags(foldedNeg.state, oneFlags, "folded NEG EAX");
  strictEqual(foldedNeg.state.instructionCount, 3);
  deepStrictEqual(foldedNeg.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(memoryNot.state.eax, 0x60);
  strictEqual(memoryNot.state.ebx, 0xedcb_a9f0);
  strictEqual(readGuestValue(memoryNot.guestView, 0x60, 32), 0xedcb_a9f0);
  strictEqual(memoryNot.state.eflags, initialEflags);
  strictEqual(memoryNot.state.instructionCount, 4);
  deepStrictEqual(memoryNot.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block omits redundant masks after byte and word memory loads", () => {
  const movAxOpcodes = singleInstructionBodyOpcodes([0x66, 0x8b, 0x03]);
  const movAlOpcodes = singleInstructionBodyOpcodes([0x8a, 0x03]);

  assertNoMaskImmediatelyAfter(movAxOpcodes, wasmOpcode.i32Load16U);
  assertNoMaskImmediatelyAfter(movAlOpcodes, wasmOpcode.i32Load8U);
});

test("jit IR block emits MOVSX with signed loads or sign-extension opcodes", () => {
  const movsxByteMem = singleInstructionBodyOpcodes([0x0f, 0xbe, 0x03]);
  const movsxWordMem = singleInstructionBodyOpcodes([0x0f, 0xbf, 0x03]);
  const movsxEbxAlBlock = buildJitIrBlock([ok(decodeBytes([0x0f, 0xbe, 0xd8], startAddress))]);
  const movsxEbxAl = jitBlockBodyOpcodes(movsxEbxAlBlock);
  const movsxAfterTrackedRegBlock = buildJitIrBlock([
    ok(decodeBytes([0x66, 0x89, 0xd8], startAddress)), // mov ax, bx
    ok(decodeBytes([0x0f, 0xbf, 0xc8], startAddress + 3)) // movsx ecx, ax
  ]);
  const movsxAfterTrackedReg = jitBlockBodyOpcodes(movsxAfterTrackedRegBlock);

  strictEqual(movsxByteMem.includes(wasmOpcode.i32Load8S), true);
  strictEqual(movsxByteMem.includes(wasmOpcode.i32Extend8S), false);
  strictEqual(movsxByteMem.includes(wasmOpcode.i32Xor), false);

  strictEqual(movsxWordMem.includes(wasmOpcode.i32Load16S), true);
  strictEqual(movsxWordMem.includes(wasmOpcode.i32Extend16S), false);
  strictEqual(movsxWordMem.includes(wasmOpcode.i32Xor), false);

  strictEqual(
    registerStateMemoryAccesses(movsxEbxAlBlock, stateOffset.eax)
      .some((access) => access.opcode === wasmOpcode.i32Load8S),
    true
  );
  strictEqual(movsxEbxAl.includes(wasmOpcode.i32Extend8S), true);
  strictEqual(movsxEbxAl.includes(wasmOpcode.i32Xor), false);

  strictEqual(movsxAfterTrackedReg.includes(wasmOpcode.i32Extend16S), true);
  strictEqual(
    registerStateMemoryAccesses(movsxAfterTrackedRegBlock, stateOffset.eax).some(
      (access) => access.opcode === wasmOpcode.i32Load16S
    ),
    false
  );
  strictEqual(movsxAfterTrackedReg.includes(wasmOpcode.i32Xor), false);
});

test("jit IR block keeps MOVZX on unsigned loads without redundant masks", () => {
  const movzxBl = singleInstructionBodyOpcodes([0x0f, 0xb6, 0xc3]);
  const movzxWordMem = singleInstructionBodyOpcodes([0x0f, 0xb7, 0x03]);

  strictEqual(movzxBl.includes(wasmOpcode.i32Load8U), true);
  strictEqual(movzxBl.includes(wasmOpcode.i32Load8S), false);
  assertNoMaskImmediatelyAfter(movzxBl, wasmOpcode.i32Load8U);

  strictEqual(movzxWordMem.includes(wasmOpcode.i32Load16U), true);
  strictEqual(movzxWordMem.includes(wasmOpcode.i32Load16S), false);
  assertNoMaskImmediatelyAfter(movzxWordMem, wasmOpcode.i32Load16U);
});

test("jit IR block omits narrow bitwise operand masks", () => {
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x66, 0x35, 0x32, 0x04]), wasmOpcode.i32Xor);
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x34, 0x12]), wasmOpcode.i32Xor);
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x66, 0x0d, 0x32, 0x04]), wasmOpcode.i32Or);
});

test("jit IR block uses full-register fallback for cold AH xor writeback", async () => {
  const bytes = [0x80, 0xf4, 0x05]; // xor ah, 5
  const block = buildJitIrBlock([ok(decodeBytes(bytes, startAddress))]);
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x1234_5678,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_5378);
  strictEqual(result.state.eflags, (preservedEflags | 0x04) >>> 0);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 1);
  // The current generic planned-source exit path writes the changed high byte
  // directly after rebuilding the source expression.
  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Load8U, offset: stateOffset.eax + 1 },
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Store8, offset: stateOffset.eax + 1 }
  ]);
});

test("jit IR block keeps cold AX xor state traffic word-width", async () => {
  const bytes = [0x66, 0x35, 0x32, 0x04]; // xor ax, 0x432
  const block = buildJitIrBlock([ok(decodeBytes(bytes, startAddress))]);
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x1234_5678,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_524a);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 1);
  // The current generic exit-store path can rebuild a planned store source from
  // the input slot before the narrow writeback.
  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Load16U, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Store16, offset: stateOffset.eax }
  ]);
});

test("jit IR block materializes a later full read after cold AH xor", async () => {
  const bytes = [
    0x80, 0xf4, 0x05, // xor ah, 5
    0x89, 0xc3 // mov ebx, eax
  ];
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x1234_5678,
    ebx: 0xaaaa_aaaa,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_5378);
  strictEqual(result.state.ebx, 0x1234_5378);
  strictEqual(result.state.eflags, (preservedEflags | 0x04) >>> 0);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
});

test("jit IR block omits redundant masks before cold narrow add and sub state loads", () => {
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x66, 0x05, 0x01, 0x00]), wasmOpcode.i32Add);
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x66, 0x2d, 0x01, 0x00]), wasmOpcode.i32Sub);
});

test("jit IR block keeps mixed partial-register bitwise mask count bounded", () => {
  const movAh = ok(decodeBytes([0xb4, 0x07], startAddress));
  const movEbxEax = ok(decodeBytes([0x89, 0xc3], movAh.nextEip));
  const xorAx = ok(decodeBytes([0x66, 0x35, 0x32, 0x04], movEbxEax.nextEip));
  const opcodes = jitBlockBodyOpcodes(buildJitIrBlock([movAh, movEbxEax, xorAx]));

  // Conservative planned-source exit capture adds two masks here.
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And) <= 11, true);
});

test("jit IR block updates cmovcc destination when the condition passes", async () => {
  const taken = await runJitIrBlock(
    [0x0f, 0x44, 0xd1], // cmove edx, ecx
    createCpuState({
      ecx: 0x2222_2222,
      edx: 0x1111_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );
  const notTaken = await runJitIrBlock(
    [0x0f, 0x44, 0xd1], // cmove edx, ecx
    createCpuState({
      ecx: 0x2222_2222,
      edx: 0x1111_1111,
      eflags: preservedEflags,
      eip: startAddress
    })
  );

  strictEqual(taken.state.edx, 0x2222_2222);
  strictEqual(taken.state.eflags, (preservedEflags | zeroFlag) >>> 0);
  strictEqual(taken.state.instructionCount, 1);
  strictEqual(notTaken.state.edx, 0x1111_1111);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.instructionCount, 1);
});

test("jit IR block emits cmovcc through a select value and normal write", () => {
  const instruction = ok(decodeBytes([0x0f, 0x44, 0xd1], startAddress));
  const block = buildJitIrBlock([instruction]);
  const ir = block.instructions[0]!.ir;
  const opcodes = jitBlockBodyOpcodes(block);

  deepStrictEqual(ir, [
    { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "operand", index: 1 }, accessWidth: 32 },
    { op: "flags.condition", dst: { kind: "var", id: 1 }, cc: "E" },
    { op: "get", dst: { kind: "var", id: 2 }, source: { kind: "operand", index: 0 }, accessWidth: 32 },
    {
      op: "value.select",
      type: "i32",
      dst: { kind: "var", id: 3 },
      condition: { kind: "var", id: 1 },
      whenTrue: { kind: "var", id: 0 },
      whenFalse: { kind: "var", id: 2 }
    },
    { op: "set", target: { kind: "operand", index: 0 }, value: { kind: "var", id: 3 }, accessWidth: 32 },
    { op: "next" }
  ]);
  strictEqual(opcodes.includes(wasmOpcode.select), true);
});

test("jit IR block updates cmovcc r16 destination when the condition passes", async () => {
  const taken = await runJitIrBlock(
    [0x66, 0x0f, 0x44, 0xd1], // cmove dx, cx
    createCpuState({
      ecx: 0x3333_2222,
      edx: 0xaaaa_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );
  const notTaken = await runJitIrBlock(
    [0x66, 0x0f, 0x44, 0xd1], // cmove dx, cx
    createCpuState({
      ecx: 0x3333_2222,
      edx: 0xaaaa_1111,
      eflags: preservedEflags,
      eip: startAddress
    })
  );

  strictEqual(taken.state.edx, 0xaaaa_2222);
  strictEqual(taken.state.eflags, (preservedEflags | zeroFlag) >>> 0);
  strictEqual(taken.state.instructionCount, 1);
  strictEqual(notTaken.state.edx, 0xaaaa_1111);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.instructionCount, 1);
});

test("jit IR block keeps cmovcc fallback value after previous high-byte write", async () => {
  const result = await runJitIrBlock(
    [
      0xb4, 0x22, // mov ah, 0x22
      0x0f, 0x45, 0xc1 // cmovne eax, ecx
    ],
    createCpuState({
      eax: 0x1111_1111,
      ecx: 0x2222_2222,
      eflags: zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.eax, 0x1111_2211);
  strictEqual(result.state.ecx, 0x2222_2222);
  strictEqual(result.state.instructionCount, 2);
});

test("jit IR block keeps cmovcc source memory faults unconditional", async () => {
  const result = await runJitIrBlock(
    [0x0f, 0x45, 0x13], // cmovne edx, [ebx]
    createCpuState({
      ebx: 0x10000,
      edx: 0x1111_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.edx, 0x1111_1111);
  strictEqual(result.state.eip, startAddress);
  strictEqual(result.state.instructionCount, 0);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block keeps cmovcc r16 source memory faults unconditional", async () => {
  const result = await runJitIrBlock(
    [0x66, 0x0f, 0x45, 0x13], // cmovne dx, [ebx]
    createCpuState({
      ebx: 0x10000,
      edx: 0xaaaa_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.edx, 0xaaaa_1111);
  strictEqual(result.state.eip, startAddress);
  strictEqual(result.state.instructionCount, 0);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 2 });
});

test("jit IR block emits setcc through a select value and normal write", async () => {
  const instruction = ok(decodeBytes([0x0f, 0x94, 0xc0], startAddress));
  const ir = buildJitIrBlock([instruction]).instructions[0]!.ir;
  const selectIndex = ir.findIndex((op) => op.op === "value.select");
  const setIndex = ir.findIndex((op) => op.op === "set");
  const opcodes = jitBlockBodyOpcodes(buildJitIrBlock([instruction]));
  const taken = await runJitIrBlock(
    [0x0f, 0x94, 0xc0], // sete al
    createCpuState({ eax: 0x1234_5678, eflags: preservedEflags | zeroFlag, eip: startAddress })
  );
  const notTaken = await runJitIrBlock(
    [0x0f, 0x94, 0xc0], // sete al
    createCpuState({ eax: 0x1234_5678, eflags: preservedEflags, eip: startAddress })
  );
  const highByte = await runJitIrBlock(
    [0x0f, 0x95, 0xc4], // setne ah
    createCpuState({ eax: 0x1234_5678, eflags: preservedEflags, eip: startAddress })
  );

  strictEqual(selectIndex !== -1 && setIndex === selectIndex + 1, true);
  strictEqual(ir[selectIndex]?.op === "value.select" ? constValue(ir[selectIndex].whenTrue) : undefined, 1);
  strictEqual(ir[selectIndex]?.op === "value.select" ? constValue(ir[selectIndex].whenFalse) : undefined, 0);
  strictEqual(ir[setIndex]?.op === "set" ? ir[setIndex].accessWidth : undefined, 8);
  strictEqual(opcodes.includes(wasmOpcode.select), true);

  strictEqual(taken.state.eax, 0x1234_5601);
  strictEqual(taken.state.eflags, (preservedEflags | zeroFlag) >>> 0);
  strictEqual(taken.state.instructionCount, 1);
  strictEqual(notTaken.state.eax, 0x1234_5600);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.instructionCount, 1);
  strictEqual(highByte.state.eax, 0x1234_0178);
  strictEqual(highByte.state.eflags, preservedEflags);
  strictEqual(highByte.state.instructionCount, 1);
});

test("jit IR block emits memory setcc as a selected byte store", async () => {
  const taken = await runJitIrBlock(
    [0x0f, 0x94, 0x03], // sete [ebx]
    createCpuState({ ebx: 0x20, eflags: preservedEflags | zeroFlag, eip: startAddress }),
    [{ address: 0x20, bytes: [0xaa] }]
  );
  const notTaken = await runJitIrBlock(
    [0x0f, 0x94, 0x03], // sete [ebx]
    createCpuState({ ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0xaa] }]
  );

  strictEqual(taken.guestView.getUint8(0x20), 1);
  strictEqual(taken.state.eflags, (preservedEflags | zeroFlag) >>> 0);
  strictEqual(taken.state.instructionCount, 1);
  strictEqual(notTaken.guestView.getUint8(0x20), 0);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.instructionCount, 1);
});

test("jit IR block lowers setcc conditions from local flag value state", async () => {
  const cmp = ok(decodeBytes([0x39, 0xd8], startAddress));
  const sete = ok(decodeBytes([0x0f, 0x94, 0xc0], cmp.nextEip));
  const ir = codegenIr(buildJitIrBlock([cmp, sete]));
  const equal = await runJitIrBlock(
    [
      0x39, 0xd8, // cmp eax, ebx
      0x0f, 0x94, 0xc0 // sete al
    ],
    createCpuState({ eax: 0x1234_5678, ebx: 0x1234_5678, eflags: preservedEflags, eip: startAddress })
  );
  const notEqual = await runJitIrBlock(
    [
      0x39, 0xd8, // cmp eax, ebx
      0x0f, 0x94, 0xc0 // sete al
    ],
    createCpuState({ eax: 0x1234_5678, ebx: 0x1234_5679, eflags: preservedEflags, eip: startAddress })
  );

  strictEqual(ir.some((op) => op.op === "flags.condition"), true);
  strictEqual(equal.state.eax, 0x1234_5601);
  strictEqual(equal.state.instructionCount, 2);
  strictEqual(notEqual.state.eax, 0x1234_5600);
  strictEqual(notEqual.state.instructionCount, 2);
});

test("jit IR block freezes cmovcc-selected register values before later full-register copies", async () => {
  const result = await runJitIrBlock(
    [
      0x0f, 0x44, 0xc1, // cmove eax, ecx
      0x89, 0xc3, // mov ebx, eax
      0x0f, 0x44, 0xc2 // cmove eax, edx
    ],
    createCpuState({
      eax: 0x1111_1111,
      ebx: 0xbbbb_bbbb,
      ecx: 0x2222_2222,
      edx: 0x3333_3333,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.eax, 0x3333_3333);
  strictEqual(result.state.ebx, 0x2222_2222);
  strictEqual(result.state.ecx, 0x2222_2222);
  strictEqual(result.state.edx, 0x3333_3333);
  strictEqual(result.state.eip, startAddress + 8);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 8 });
});

test("jit IR block preserves committed cmovcc writes on later pre-instruction exits", async () => {
  const result = await runJitIrBlock(
    [
      0x0f, 0x44, 0xd1, // cmove edx, ecx
      0x8b, 0x03 // mov eax, [ebx]
    ],
    createCpuState({
      eax: 0xaaaa_aaaa,
      ebx: 0x10000,
      ecx: 0x2222_2222,
      edx: 0x1111_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.eax, 0xaaaa_aaaa);
  strictEqual(result.state.edx, 0x2222_2222);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block preserves a pre-instruction exit before later cmovcc mutation of the same register", async () => {
  const result = await runJitIrBlock(
    [
      0x0f, 0x44, 0xc1, // cmove eax, ecx
      0x8b, 0x16, // mov edx, [esi]
      0x0f, 0x44, 0xc3 // cmove eax, ebx
    ],
    createCpuState({
      eax: 0x1111_1111,
      ebx: 0x3333_3333,
      ecx: 0x2222_2222,
      edx: 0xdddd_dddd,
      esi: 0x10000,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.eax, 0x2222_2222);
  strictEqual(result.state.ebx, 0x3333_3333);
  strictEqual(result.state.edx, 0xdddd_dddd);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block emits leave", async () => {
  const result = await runJitIrBlock(
    [0xc9],
    createCpuState({ ebp: 0x20, esp: 0x100, eip: startAddress }),
    [{ address: 0x20, bytes: [0x78, 0x56, 0x34, 0x12] }]
  );

  strictEqual(result.state.ebp, 0x1234_5678);
  strictEqual(result.state.esp, 0x24);
  strictEqual(result.state.eip, startAddress + 1);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block folds stack updates after successful memory fault points", async () => {
  const result = await runJitIrBlock([
    0x50, // push eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0x1234_5678,
    esp: 0x24,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.guestView.getUint32(0x20, true), 0x1234_5678);
  strictEqual(result.state.esp, 0x20);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block keeps deferred flags live after memory-store fault branch emission", async () => {
  const result = await runJitIrBlock([
    0x01, 0x18, // add [eax], ebx
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0x20,
    ebx: 2,
    eip: startAddress
  }), [{ address: 0x20, bytes: [1, 0, 0, 0] }]);

  strictEqual(result.guestView.getUint32(0x20, true), 3);
  strictEqual(result.state.eflags, 0x04);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block emits add and materializes flags", async () => {
  const result = await runJitIrBlock([0x83, 0xc0, 0x01], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block emits or and materializes logic flags", async () => {
  const result = await runJitIrBlock([0x0d, 0x00, 0x01, 0x00, 0x00], createCpuState({
    eax: 0x8000_0000,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x8000_0100);
  strictEqual(result.state.eflags, (preservedEflags | 0x84) >>> 0);
  strictEqual(result.state.eip, startAddress + 5);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block materializes the latest deferred flags on exit", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x83, 0xc0, 0x01, // add eax, 1
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 1);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 8);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block keeps mixed cached pending flag inputs stable after invalidation and recache", async () => {
  const instructionBytes = [
    [0x83, 0xc0, 0x01], // add eax, 1
    [0x8b, 0x05, 0x60, 0x00, 0x00, 0x00], // mov eax, [0x60]
    [0x40], // inc eax (preserves CF, updates the other ALU flags)
    [0xcd, 0x2e] // int 0x2e
  ];
  const expectedFlags = {
    CF: false,
    OF: false,
    SF: false,
    ZF: true,
    PF: true,
    AF: true
  };
  let decodeEip = startAddress;
  const block = buildJitIrBlock(instructionBytes.map((bytes) => {
    const instruction = ok(decodeBytes(bytes, decodeEip));

    decodeEip = instruction.nextEip;
    return instruction;
  }));
  const guestLoads = memoryAccesses(extractOnlyFunctionBody(encodeJitIrBlock([block])))
    .filter((access) => access.memoryIndex === wasmMemoryIndex.guest && access.opcode === wasmOpcode.i32Load);
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 1,
    eflags: (preservedEflags | allArithmeticEflags) >>> 0,
    eip: startAddress
  }), [{ address: 0x60, bytes: littleEndianBytes(0xffff_ffff, 32) }]);

  strictEqual(guestLoads.length, 1);
  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | arithmeticEflags(expectedFlags)) >>> 0);
  assertArithmeticFlags(result.state, expectedFlags, "cached pending flag input");
  strictEqual(result.state.eip, startAddress + 12);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block folds transient register value calculations", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x83, 0xf0, 0x02, // xor eax, 2
    0x01, 0xc3, // add ebx, eax
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 10,
    ecx: 5,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.ebx, 17);
  strictEqual(result.state.ecx, 5);
  strictEqual(result.state.eip, startAddress + 14);
  strictEqual(result.state.instructionCount, 5);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block materializes register values before memory fault exits", async () => {
  const load = 0x10000;
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x8b, 0x15, 0x00, 0x00, 0x01, 0x00 // mov edx, [0x10000]
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ecx: 0x1234_5678,
    edx: 0xeeee_eeee,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_5678);
  strictEqual(result.state.ecx, 0x1234_5678);
  strictEqual(result.state.edx, 0xeeee_eeee);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: load, detail: 4 });
});

test("jit IR block preserves register values before source clobbers", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0xb9, 0x00, 0x00, 0x00, 0x00, // mov ecx, 0
    0x01, 0xc3, // add ebx, eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 10,
    ecx: 7,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 7);
  strictEqual(result.state.ebx, 17);
  strictEqual(result.state.ecx, 0);
  strictEqual(result.state.eip, startAddress + 11);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block materializes repeated register value reads without changing results", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x83, 0xf0, 0x02, // xor eax, 2
    0x01, 0xc3, // add ebx, eax
    0x01, 0xc2, // add edx, eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 10,
    ecx: 5,
    edx: 20,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 7);
  strictEqual(result.state.ebx, 17);
  strictEqual(result.state.ecx, 5);
  strictEqual(result.state.edx, 27);
  strictEqual(result.state.eip, startAddress + 11);
  strictEqual(result.state.instructionCount, 5);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block folds register values into indirect jump targets", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x83, 0xf0, 0x02, // xor eax, 2
    0xff, 0xe0 // jmp eax
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ecx: 0x1234_5678,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_567a);
  strictEqual(result.state.ecx, 0x1234_5678);
  strictEqual(result.state.eip, 0x1234_567a);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.JUMP, payload: 0x1234_567a });
});

test("jit IR block folds register values into effective addresses", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x8d, 0x58, 0x04, // lea ebx, [eax+4]
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 0xbbbb_bbbb,
    ecx: 0x1234_5678,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.ebx, 0x1234_567c);
  strictEqual(result.state.ecx, 0x1234_5678);
  strictEqual(result.state.eip, startAddress + 12);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block materializes register values for scaled effective addresses", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x8d, 0x1c, 0x45, 0x04, 0x00, 0x00, 0x00, // lea ebx, [eax*2+4]
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 0xbbbb_bbbb,
    ecx: 7,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.ebx, 18);
  strictEqual(result.state.ecx, 7);
  strictEqual(result.state.eip, startAddress + 16);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block emits lea r16 without reading memory or modifying flags", async () => {
  const result = await runJitIrBlock([0x66, 0x8d, 0x44, 0xb3, 0x08], createCpuState({
    eax: 0x1234_0000,
    ebx: 0x100,
    esi: 3,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_0114);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 5);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block emits multi-byte nop without reading memory or modifying flags", async () => {
  const dword = await runJitIrBlock([0x0f, 0x1f, 0x40, 0x00], createCpuState({
    eax: 0x1_0000,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const word = await runJitIrBlock([0x66, 0x0f, 0x1f, 0x00], createCpuState({
    eax: 0x1_0000,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(dword.state.eip, startAddress + 4);
  strictEqual(dword.state.eflags, preservedEflags);
  strictEqual(dword.state.instructionCount, 1);
  deepStrictEqual(dword.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 4 });

  strictEqual(word.state.eip, startAddress + 4);
  strictEqual(word.state.eflags, preservedEflags);
  strictEqual(word.state.instructionCount, 1);
  deepStrictEqual(word.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 4 });
});

test("jit IR block preserves CF across INC partial flag writes", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x40, // inc eax
    0x72, 0x05 // jc +5
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 1);
  strictEqual(result.state.eflags, (preservedEflags | 0x01) >>> 0);
  strictEqual(result.state.eip, startAddress + 11);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.BRANCH_TAKEN, payload: startAddress + 11 });
});

test("jit IR block branches on incoming CF after INC", async () => {
  const taken = await runJitIrBlock([
    0x40, // inc eax
    0x72, 0x05 // jc +5
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags | 0x01,
    eip: startAddress
  }));
  const notTaken = await runJitIrBlock([
    0x40, // inc eax
    0x72, 0x05 // jc +5
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(taken.state.eax, 1);
  strictEqual(taken.state.eflags, (preservedEflags | 0x01) >>> 0);
  strictEqual(taken.state.eip, startAddress + 8);
  strictEqual(taken.state.instructionCount, 2);
  deepStrictEqual(taken.exit, { exitReason: ExitReason.BRANCH_TAKEN, payload: startAddress + 8 });

  strictEqual(notTaken.state.eax, 1);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.eip, startAddress + 3);
  strictEqual(notTaken.state.instructionCount, 2);
  deepStrictEqual(notTaken.exit, { exitReason: ExitReason.BRANCH_NOT_TAKEN, payload: startAddress + 3 });
});

test("jit IR block keeps not-taken INC exit stores path-local after JC", async () => {
  const result = await runJitIrBlock([
    0x40, // inc eax
    0x72, 0x05 // jc +5
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 1);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.BRANCH_NOT_TAKEN, payload: startAddress + 3 });
});

test("jit IR block emits cmp without writing operands", async () => {
  const result = await runJitIrBlock([0x39, 0xd8], createCpuState({
    eax: 5,
    ebx: 5,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 5);
  strictEqual(result.state.ebx, 5);
  strictEqual(result.state.eflags, (preservedEflags | zeroResultEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block handles specialized cmp condition branches", async () => {
  const takenCases = [
    { name: "JE", opcode: 0x74, eax: 5, ebx: 5 },
    { name: "JNE", opcode: 0x75, eax: 5, ebx: 6 },
    { name: "JB", opcode: 0x72, eax: 1, ebx: 2 },
    { name: "JAE", opcode: 0x73, eax: 2, ebx: 1 },
    { name: "JL", opcode: 0x7c, eax: 0xffff_ffff, ebx: 1 },
    { name: "JGE", opcode: 0x7d, eax: 1, ebx: 0xffff_ffff },
    { name: "JLE", opcode: 0x7e, eax: 0xffff_ffff, ebx: 1 },
    { name: "JG", opcode: 0x7f, eax: 1, ebx: 0xffff_ffff }
  ] as const;

  for (const testCase of takenCases) {
    const result = await runJitIrBlock([
      0x39, 0xd8, // cmp eax, ebx
      testCase.opcode, 0x05
    ], createCpuState({
      eax: testCase.eax,
      ebx: testCase.ebx,
      eip: startAddress
    }));

    strictEqual(result.state.eip, startAddress + 9, testCase.name);
    strictEqual(result.state.instructionCount, 2, testCase.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.BRANCH_TAKEN, payload: startAddress + 9 });
  }
});

test("jit IR block materializes deferred flags before condition consumers", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x74, 0x05 // jz +5
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 10);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.BRANCH_TAKEN, payload: startAddress + 10 });
});

test("jit IR block commits deferred flags on both conditional branch exits", async () => {
  const taken = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x74, 0x05 // jz +5
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const notTaken = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x74, 0x05 // jz +5
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(taken.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  deepStrictEqual(taken.exit, { exitReason: ExitReason.BRANCH_TAKEN, payload: startAddress + 10 });
  strictEqual(notTaken.state.eflags, preservedEflags);
  deepStrictEqual(notTaken.exit, { exitReason: ExitReason.BRANCH_NOT_TAKEN, payload: startAddress + 5 });
});

test("jit IR block emits conditional branches", async () => {
  const taken = await runJitIrBlock([0x75, 0x05], createCpuState({
    eip: startAddress,
    instructionCount: 10
  }));
  const notTaken = await runJitIrBlock([0x75, 0x05], createCpuState({
    eip: startAddress,
    eflags: zeroFlag,
    instructionCount: 10
  }));

  deepStrictEqual(taken.exit, { exitReason: ExitReason.BRANCH_TAKEN, payload: startAddress + 7 });
  strictEqual(taken.state.eip, startAddress + 7);
  strictEqual(taken.state.instructionCount, 11);
  deepStrictEqual(notTaken.exit, { exitReason: ExitReason.BRANCH_NOT_TAKEN, payload: startAddress + 2 });
  strictEqual(notTaken.state.eip, startAddress + 2);
  strictEqual(notTaken.state.instructionCount, 11);
});

test("jit IR block materializes deferred flags on later fault exits", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x8b, 0x05, 0x00, 0x00, 0x01, 0x00 // mov eax, [0x10000]
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block preserves incoming CF across INC on later fault exits", async () => {
  const result = await runJitIrBlock([
    0x40, // inc eax (preserves CF, updates the other ALU flags)
    0x8b, 0x05, 0x00, 0x00, 0x01, 0x00 // mov eax, [0x10000]
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags | 0x01,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 1);
  strictEqual(getFlag(result.state, "CF"), true);
  strictEqual(result.state.eip, startAddress + 1);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block keeps flags live across memory fault exits before later overwrites", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x8b, 0x05, 0x00, 0x00, 0x01, 0x00, // mov eax, [0x10000]
    0x83, 0xc0, 0x01 // add eax, 1
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

type ArithmeticFlagExpectations = Readonly<{
  CF: boolean;
  OF: boolean;
  SF: boolean;
  ZF: boolean;
  PF: boolean;
  AF: boolean;
}>;

function assertArithmeticFlags(
  state: ReturnType<typeof createCpuState>,
  expected: ArithmeticFlagExpectations,
  label: string
): void {
  strictEqual(getFlag(state, "CF"), expected.CF, `${label} CF`);
  strictEqual(getFlag(state, "OF"), expected.OF, `${label} OF`);
  strictEqual(getFlag(state, "SF"), expected.SF, `${label} SF`);
  strictEqual(getFlag(state, "ZF"), expected.ZF, `${label} ZF`);
  strictEqual(getFlag(state, "PF"), expected.PF, `${label} PF`);
  strictEqual(getFlag(state, "AF"), expected.AF, `${label} AF`);
}

function arithmeticEflags(flags: ArithmeticFlagExpectations): number {
  return (
    (flags.CF ? 0x001 : 0) |
    (flags.PF ? 0x004 : 0) |
    (flags.AF ? 0x010 : 0) |
    (flags.ZF ? 0x040 : 0) |
    (flags.SF ? 0x080 : 0) |
    (flags.OF ? 0x800 : 0)
  ) >>> 0;
}

function codegenIr(block: ReturnType<typeof buildJitIrBlock>): readonly JitIrOp[] {
  return blockIr(optimizeJitIrBlock(block));
}

function blockIr(block: ReturnType<typeof optimizeJitIrBlock>): readonly JitIrOp[] {
  return block.instructions.flatMap((instruction) => instruction.ir);
}

function constValue(value: ValueRef): number | undefined {
  return value.kind === "const" ? value.value : undefined;
}

function littleEndianBytes(value: number, width: 8 | 16 | 32): readonly number[] {
  const byteCount = width / 8;

  return Array.from({ length: byteCount }, (_, index) => (value >>> (index * 8)) & 0xff);
}

function readGuestValue(view: DataView, address: number, width: 8 | 16 | 32): number {
  switch (width) {
    case 8:
      return view.getUint8(address);
    case 16:
      return view.getUint16(address, true);
    case 32:
      return view.getUint32(address, true);
  }
}

function decodedBlock(instructionBytes: readonly (readonly number[])[]): ReturnType<typeof buildJitIrBlock> {
  const instructions = [];
  let decodeEip = startAddress;

  for (const bytes of instructionBytes) {
    const instruction = ok(decodeBytes(bytes, decodeEip));

    instructions.push(instruction);
    decodeEip = instruction.nextEip;
  }

  return buildJitIrBlock(instructions);
}

function singleInstructionBodyOpcodes(bytes: readonly number[]): readonly number[] {
  return jitBlockBodyOpcodes(buildJitIrBlock([ok(decodeBytes(bytes, startAddress))]));
}

function jitBlockBodyOpcodes(block: ReturnType<typeof buildJitIrBlock>): readonly number[] {
  return wasmBodyOpcodes(extractOnlyFunctionBody(encodeJitIrBlock([block])));
}

function assertNoMaskImmediatelyAfter(opcodes: readonly number[], opcode: number): void {
  const index = requiredOpcodeIndex(opcodes, opcode);

  strictEqual(opcodes[index + 1] === wasmOpcode.i32Const && opcodes[index + 2] === wasmOpcode.i32And, false);
}

function assertNoOperandMaskBefore(opcodes: readonly number[], opcode: number): void {
  const index = requiredOpcodeIndex(opcodes, opcode);

  strictEqual(opcodes.slice(Math.max(0, index - 3), index).includes(wasmOpcode.i32And), false);
}

function requiredOpcodeIndex(opcodes: readonly number[], opcode: number): number {
  const index = opcodes.indexOf(opcode);

  if (index === -1) {
    throw new Error(`missing Wasm opcode in JIT body: 0x${opcode.toString(16)}`);
  }

  return index;
}

function opcodeIndexes(opcodes: readonly number[], opcode: number): readonly number[] {
  const indexes: number[] = [];

  for (let index = 0; index < opcodes.length; index += 1) {
    if (opcodes[index] === opcode) {
      indexes.push(index);
    }
  }

  return indexes;
}

function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodeIndexes(opcodes, opcode).length;
}

function irOpDstId(op: JitIrOp): readonly number[] {
  const dst = irOpDst(op);

  return dst === undefined ? [] : [dst.id];
}

function irOpOperandIndexes(op: JitIrOp): readonly number[] {
  switch (op.op) {
    case "get":
      return storageOperandIndexes(op.source);
    case "set":
      return storageOperandIndexes(op.target);
    case "address":
      return [op.operand.index];
    default:
      return [];
  }
}

function storageOperandIndexes(storage: StorageRef): readonly number[] {
  switch (storage.kind) {
    case "operand":
      return [storage.index];
    case "mem":
      return [];
    case "reg":
      return [];
  }
}

function aluFlagMemoryAccessCounts(block: ReturnType<typeof buildJitIrBlock>): Readonly<{ loads: number; stores: number }> {
  let loads = 0;
  let stores = 0;

  for (const access of memoryAccesses(extractOnlyFunctionBody(encodeJitIrBlock([block])))) {
    if (access.memoryIndex !== 0 || access.offset !== stateOffset.aluFlags) {
      continue;
    }

    if (access.opcode === wasmOpcode.i32Load) {
      loads += 1;
    } else if (access.opcode === wasmOpcode.i32Store) {
      stores += 1;
    }
  }

  return { loads, stores };
}

function stateMemoryLoads(block: ReturnType<typeof buildJitIrBlock>): readonly number[] {
  return memoryAccesses(extractOnlyFunctionBody(encodeJitIrBlock([block])))
    .filter((access) => access.memoryIndex === 0 && access.opcode === wasmOpcode.i32Load)
    .map((access) => access.offset);
}

function registerStateMemoryAccesses(
  block: ReturnType<typeof buildJitIrBlock>,
  regOffset: number
): readonly Readonly<{ opcode: number; offset: number }>[] {
  return memoryAccesses(extractOnlyFunctionBody(encodeJitIrBlock([block])))
    .filter((access) =>
      access.memoryIndex === wasmMemoryIndex.state &&
      access.offset >= regOffset &&
      access.offset < regOffset + 4
    )
    .map((access) => ({ opcode: access.opcode, offset: access.offset }));
}

type WasmMemoryAccess = Readonly<{
  opcode: number;
  memoryIndex: number;
  offset: number;
}>;

function memoryAccesses(functionBody: Uint8Array<ArrayBuffer>): readonly WasmMemoryAccess[] {
  const accesses: WasmMemoryAccess[] = [];
  let offset = skipLocalDeclarations(functionBody);

  while (offset < functionBody.length) {
    const opcode = requiredByte(functionBody, offset);

    offset += 1;

    switch (opcode) {
      case wasmOpcode.localGet:
      case wasmOpcode.localSet:
      case wasmOpcode.localTee:
      case wasmOpcode.br:
      case wasmOpcode.call:
      case wasmOpcode.returnCall:
      case wasmOpcode.memorySize:
        offset = readU32Leb128(functionBody, offset).nextOffset;
        break;
      case wasmOpcode.brTable: {
        const tableLength = readU32Leb128(functionBody, offset);

        offset = tableLength.nextOffset;

        for (let index = 0; index < tableLength.value; index += 1) {
          offset = readU32Leb128(functionBody, offset).nextOffset;
        }

        offset = readU32Leb128(functionBody, offset).nextOffset;
        break;
      }
      case wasmOpcode.block:
      case wasmOpcode.loop:
      case wasmOpcode.if:
        offset += 1;
        break;
      case wasmOpcode.i32Const:
      case wasmOpcode.i64Const:
        offset = skipLeb128(functionBody, offset);
        break;
      case wasmOpcode.i32Load:
      case wasmOpcode.i32Load8S:
      case wasmOpcode.i32Load8U:
      case wasmOpcode.i32Load16S:
      case wasmOpcode.i32Load16U:
      case wasmOpcode.i32Store:
      case wasmOpcode.i32Store8:
      case wasmOpcode.i32Store16: {
        const memory = readMemoryImmediate(functionBody, offset);

        offset = memory.nextOffset;
        accesses.push({
          opcode,
          memoryIndex: memory.memoryIndex,
          offset: memory.offset
        });
        break;
      }
      case wasmOpcode.else:
      case wasmOpcode.return:
      case wasmOpcode.drop:
      case wasmOpcode.select:
      case wasmOpcode.i32Eqz:
      case wasmOpcode.i32LtU:
      case wasmOpcode.i32GtU:
      case wasmOpcode.i32Popcnt:
      case wasmOpcode.i32Add:
      case wasmOpcode.i32Sub:
      case wasmOpcode.i32And:
      case wasmOpcode.i32Or:
      case wasmOpcode.i32Xor:
      case wasmOpcode.i32Shl:
      case wasmOpcode.i32ShrU:
      case wasmOpcode.i64Or:
      case wasmOpcode.i64ExtendI32U:
      case wasmOpcode.i32Extend8S:
      case wasmOpcode.i32Extend16S:
      case wasmOpcode.end:
        break;
      default:
        throw new Error(`unsupported Wasm opcode in JIT block test: 0x${opcode.toString(16)}`);
    }
  }

  return accesses;
}

function extractOnlyFunctionBody(moduleBytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let offset = 8;

  while (offset < moduleBytes.length) {
    const sectionId = requiredByte(moduleBytes, offset);
    const sectionSize = readU32Leb128(moduleBytes, offset + 1);
    const sectionStart = sectionSize.nextOffset;
    const sectionEnd = sectionStart + sectionSize.value;

    if (sectionId === wasmSectionId.code) {
      const functionCount = readU32Leb128(moduleBytes, sectionStart);

      strictEqual(functionCount.value, 1);

      const bodySize = readU32Leb128(moduleBytes, functionCount.nextOffset);
      const bodyStart = bodySize.nextOffset;

      return moduleBytes.slice(bodyStart, bodyStart + bodySize.value);
    }

    offset = sectionEnd;
  }

  throw new Error("missing Wasm code section");
}

function skipLocalDeclarations(bytes: Uint8Array<ArrayBuffer>): number {
  const groupCount = readU32Leb128(bytes, 0);
  let offset = groupCount.nextOffset;

  for (let index = 0; index < groupCount.value; index += 1) {
    const groupSize = readU32Leb128(bytes, offset);

    offset = groupSize.nextOffset + 1;
  }

  return offset;
}

function readMemoryImmediate(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number
): Readonly<{ memoryIndex: number; offset: number; nextOffset: number }> {
  const align = readU32Leb128(bytes, offset);
  const hasMemoryIndex = (align.value & 0x40) !== 0;

  if (!hasMemoryIndex) {
    const memoryOffset = readU32Leb128(bytes, align.nextOffset);

    return { memoryIndex: 0, offset: memoryOffset.value, nextOffset: memoryOffset.nextOffset };
  }

  const memoryIndex = readU32Leb128(bytes, align.nextOffset);
  const memoryOffset = readU32Leb128(bytes, memoryIndex.nextOffset);

  return { memoryIndex: memoryIndex.value, offset: memoryOffset.value, nextOffset: memoryOffset.nextOffset };
}

function skipLeb128(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  while ((requiredByte(bytes, offset) & 0x80) !== 0) {
    offset += 1;
  }

  return offset + 1;
}

function readU32Leb128(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number
): Readonly<{ value: number; nextOffset: number }> {
  let value = 0;
  let shift = 0;

  while (true) {
    const byte = requiredByte(bytes, offset);

    value |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, nextOffset: offset };
    }

    shift += 7;
  }
}

function requiredByte(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  const byte = bytes[offset];

  if (byte === undefined) {
    throw new Error(`unexpected end of Wasm bytes at offset ${offset}`);
  }

  return byte;
}
