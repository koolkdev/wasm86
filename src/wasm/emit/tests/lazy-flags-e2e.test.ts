import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import type { IrBlock } from "#ir/block.js";
import { immBinding, regBinding, type OperandBinding } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import { CONDITIONS, type ConditionCode, type FlagBoolExpr } from "#core/conditions.js";
import { decodeBytes, ok } from "#core/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import { CONDITION_CODE_DESCRIPTORS } from "#core/instructions/condition-codes.js";
import { x86EflagsBitOffset, x86Flags, x86StatusFlags, type X86Flag, type X86StatusFlag } from "#core/flags.js";
import { widthMask, type OperandWidth } from "#core/types.js";
import { WASM_CPU_LAZY_FLAGS_KIND } from "#wasm/cpu-state-layout.js";
import {
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#runtime/tests/fixtures/cpu-state.js";
import { aluReference, type AluFlags } from "./reference.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";

type BinaryLazyFlagsCase = Readonly<{ width: OperandWidth; left: number; right: number }>;
type LogicLazyFlagsCase = Readonly<{ width: OperandWidth; result: number }>;

const compareFamilyConditionCodes = [
  "E",
  "NE",
  "B",
  "AE",
  "BE",
  "A",
  "L",
  "GE",
  "LE",
  "G"
] as const satisfies readonly ConditionCode[];

const directSubCases = [
  { width: 8, left: 0x1234_5680, right: 0xdead_be7f },
  { width: 16, left: 0x9999_7fff, right: 0x7777_8000 },
  { width: 32, left: 0xffff_ffff, right: 0x0000_0000 }
] as const satisfies readonly BinaryLazyFlagsCase[];

test("jcc and setcc use direct lazy SUB arms for compare-family conditions", async () => {
  for (const entry of directSubCases) {
    const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
    const explicitFlags = oppositeStatusFlags(lazyFlags);
    const states = [
      {
        name: "seeded",
        address: 0x1000,
        state: {
          ...subLazyFlagsState(entry),
          ...explicitFlags
        }
      },
      {
        name: "produced",
        address: 0x2000,
        state: await producedSubState(entry, explicitFlags)
      }
    ] as const;

    for (const state of states) {
      for (const cc of compareFamilyConditionCodes) {
        await assertJccReadsLazySub(cc, entry, state.state, state.address, `${state.name} SUB${entry.width} ${cc}`);
        await assertSetccReadsLazySub(cc, entry, state.state, state.address, `${state.name} SUB${entry.width} ${cc}`);
      }
    }
  }
});

test("direct-capable live-in conditions fall back to concrete flags for NONE lazy state", async () => {
  const explicitFlags = { CF: 1, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;
  const state = {
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.NONE, 0),
    lazyFlagsA: 0,
    lazyFlagsB: 0,
    ...explicitFlags
  };
  const jbe = ok(decodeBytes(jccBytes("BE")));
  const setbe = ok(decodeBytes(setccBytes("BE")));

  {
    const { stateView, run } = await instantiateIrBlock(blockOf([jbe]));

    writeWasmCpuStateSnapshot(stateView, { eip: jbe.address, ...state });
    strictEqual(run(), irBlockCompleted, "jbe NONE fallback");
    strictEqual(readWasmCpuStateChannel(stateView, eipChannel), relTarget(jbe), "jbe NONE fallback eip");
    assertStatusFlags(stateView, explicitFlags, "jbe NONE fallback");
  }

  {
    const { stateView, run } = await instantiateIrBlock(blockOf([setbe]));

    writeWasmCpuStateSnapshot(stateView, { eax: 0x55aa_5500, eip: setbe.address, ...state });
    strictEqual(run(), irBlockCompleted, "setbe NONE fallback");
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 0x55aa_5501, "setbe NONE fallback eax");
    assertStatusFlags(stateView, explicitFlags, "setbe NONE fallback");
  }
});

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
    const explicitFlags = oppositeStatusFlags(lazyFlags);

    writeWasmCpuStateSnapshot(stateView, {
      eip: 0x1000,
      ...subLazyFlagsState({ width: 32, left: entry.left, right: entry.right }),
      ...explicitFlags
    });

    strictEqual(run(), irBlockCompleted, entry.name);
    strictEqual(
      readWasmCpuStateChannel(stateView, eipChannel),
      entry.taken ? relTarget(instruction) : instruction.nextEip,
      `${entry.name} eip`
    );
    assertStatusFlags(stateView, explicitFlags, entry.name);
  }
});

test("jcc resolves seeded ADD32 lazy flag metadata", async () => {
  const cases = [
    { name: "je taken", bytes: [0x74, 0x20], left: 0xffff_ffff, right: 0x0000_0001, taken: true },
    { name: "je not taken", bytes: [0x74, 0x20], left: 0x0000_0001, right: 0x0000_0001, taken: false }
  ] as const;

  for (const entry of cases) {
    const instruction = ok(decodeBytes(entry.bytes));
    const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));
    const lazyFlags = aluReference("add", 32, entry.left, entry.right).flags;
    const explicitFlags = oppositeStatusFlags(lazyFlags);

    writeWasmCpuStateSnapshot(stateView, {
      eip: instruction.address,
      ...addLazyFlagsState({ width: 32, left: entry.left, right: entry.right }),
      ...explicitFlags
    });

    strictEqual(run(), irBlockCompleted, entry.name);
    strictEqual(
      readWasmCpuStateChannel(stateView, eipChannel),
      entry.taken ? relTarget(instruction) : instruction.nextEip,
      `${entry.name} eip`
    );
    assertStatusFlags(stateView, explicitFlags, entry.name);
  }
});

test("jcc resolves seeded LOGIC_RESULT lazy flag metadata", async () => {
  const cases = [
    { name: "je taken", bytes: [0x74, 0x20], width: 32, result: 0, taken: true },
    { name: "je not taken", bytes: [0x74, 0x20], width: 32, result: 0x8000_0000, taken: false },
    { name: "jne taken", bytes: [0x75, 0x20], width: 16, result: 0x8000, taken: true },
    { name: "jne not taken", bytes: [0x75, 0x20], width: 8, result: 0, taken: false }
  ] as const;

  for (const entry of cases) {
    const instruction = ok(decodeBytes(entry.bytes));
    const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));
    const lazyFlags = aluReference("or", entry.width, entry.result, 0).flags;
    const explicitFlags = oppositeStatusFlags(lazyFlags);

    writeWasmCpuStateSnapshot(stateView, {
      eip: instruction.address,
      ...logicLazyFlagsState(entry),
      ...explicitFlags
    });

    strictEqual(run(), irBlockCompleted, entry.name);
    strictEqual(
      readWasmCpuStateChannel(stateView, eipChannel),
      entry.taken ? relTarget(instruction) : instruction.nextEip,
      `${entry.name} eip`
    );
    assertStatusFlags(stateView, explicitFlags, entry.name);
  }
});

test("setcc resolves seeded SUB32 lazy flag metadata", async () => {
  const cases: readonly BinaryLazyFlagsCase[] = [
    { width: 32, left: 0x0000_0000, right: 0x0000_0001 },
    { width: 32, left: 0x8000_0000, right: 0x0000_0001 },
    { width: 32, left: 0x1234_5678, right: 0x1234_5678 }
  ];
  const { stateView, run } = await instantiateIrBlock(setbeBlock());

  for (const entry of cases) {
    const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
    const explicitFlags = oppositeStatusFlags(lazyFlags);
    const label = `setbe with SUB32 ${hex(entry.left)} - ${hex(entry.right)}`;

    writeWasmCpuStateSnapshot(stateView, {
      eax: 0x55aa_5500,
      eip: 0x1000,
      ...subLazyFlagsState(entry),
      ...explicitFlags
    });

    strictEqual(run(), irBlockCompleted, label);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      0x55aa_5500 + (evaluateCondition(CONDITIONS.BE.expr, flagSet(lazyFlags)) ? 1 : 0),
      label
    );
    strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x1003, `${label} eip`);
    assertStatusFlags(stateView, explicitFlags, label);
  }
});

test("setcc resolves seeded SUB8 and SUB16 lazy flag metadata", async () => {
  const cases: readonly BinaryLazyFlagsCase[] = [
    { width: 8, left: 0x1200, right: 0x3401 },
    { width: 8, left: 0x1280, right: 0x3401 },
    { width: 16, left: 0x9999_1234, right: 0x7777_1234 },
    { width: 16, left: 0x9999_8000, right: 0x7777_0001 }
  ];
  const { stateView, run } = await instantiateIrBlock(setbeBlock());

  for (const entry of cases) {
    const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
    const explicitFlags = oppositeStatusFlags(lazyFlags);
    const label = `setbe with SUB${entry.width} ${hex(entry.left)} - ${hex(entry.right)}`;

    writeWasmCpuStateSnapshot(stateView, {
      eax: 0x55aa_5500,
      eip: 0x1000,
      ...subLazyFlagsState(entry),
      ...explicitFlags
    });

    strictEqual(run(), irBlockCompleted, label);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      0x55aa_5500 + (evaluateCondition(CONDITIONS.BE.expr, flagSet(lazyFlags)) ? 1 : 0),
      label
    );
    strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x1003, `${label} eip`);
    assertStatusFlags(stateView, explicitFlags, label);
  }
});

test("setcc resolves seeded LOGIC_RESULT lazy flag metadata", async () => {
  const cases: readonly LogicLazyFlagsCase[] = [
    { width: 8, result: 0 },
    { width: 16, result: 0x8000 },
    { width: 32, result: 0x1234_5678 }
  ];
  const { stateView, run } = await instantiateIrBlock(setbeBlock());

  for (const entry of cases) {
    const lazyFlags = aluReference("or", entry.width, entry.result, 0).flags;
    const explicitFlags = oppositeStatusFlags(lazyFlags);
    const label = `setbe with LOGIC_RESULT${entry.width} ${hex(entry.result)}`;

    writeWasmCpuStateSnapshot(stateView, {
      eax: 0x55aa_5500,
      eip: 0x1000,
      ...logicLazyFlagsState(entry),
      ...explicitFlags
    });

    strictEqual(run(), irBlockCompleted, label);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      0x55aa_5500 + (evaluateCondition(CONDITIONS.BE.expr, flagSet(lazyFlags)) ? 1 : 0),
      label
    );
    strictEqual(readWasmCpuStateChannel(stateView, eipChannel), 0x1003, `${label} eip`);
    assertStatusFlags(stateView, explicitFlags, label);
  }
});

test("pushfd resolves seeded SUB32 lazy flag metadata", async () => {
  const entry = { width: 32, left: 0x0000_0000, right: 0x0000_0001 } as const;
  const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);
  const nonStatusFlags = { TF: 1, DF: 1, NT: 1, AC: 1, ID: 1 } as const;
  const instruction = ok(decodeBytes([0x9c]));

  const { stateView, guestView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, {
    esp: 0x40,
    eip: instruction.address,
    ...subLazyFlagsState(entry),
    ...explicitFlags,
    ...nonStatusFlags
  });

  strictEqual(run(), irBlockCompleted);
  strictEqual(guestView.getUint32(0x3c, true), expectedPushfdImage({ ...lazyFlags, ...nonStatusFlags }));
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esp")), 0x3c);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  assertStatusFlags(stateView, explicitFlags, "pushfd");
});

test("pushfd resolves seeded LOGIC_RESULT lazy flag metadata", async () => {
  const entry = { width: 32, result: 0x8000_0000 } as const;
  const lazyFlags = aluReference("or", entry.width, entry.result, 0).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);
  const nonStatusFlags = { TF: 1, DF: 1, NT: 1, AC: 1, ID: 1 } as const;
  const instruction = ok(decodeBytes([0x9c]));

  const { stateView, guestView, run } = await instantiateIrBlock(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, {
    esp: 0x40,
    eip: instruction.address,
    ...logicLazyFlagsState(entry),
    ...explicitFlags,
    ...nonStatusFlags
  });

  strictEqual(run(), irBlockCompleted);
  strictEqual(guestView.getUint32(0x3c, true), expectedPushfdImage({ ...lazyFlags, ...nonStatusFlags }));
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esp")), 0x3c);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), instruction.nextEip);
  assertStatusFlags(stateView, explicitFlags, "pushfd logic");
});

test("pushfd consumes ADD8, ADD16, and ADD32 records committed by previous add blocks", async () => {
  const cases = [
    { name: "ADD8", bytes: [0x00, 0xd8], width: 8, left: 0xff, right: 1 },
    { name: "ADD16", bytes: [0x66, 0x01, 0xd8], width: 16, left: 0xffff, right: 1 },
    { name: "ADD32", bytes: [0x01, 0xd8], width: 32, left: 0xffff_ffff, right: 1 }
  ] as const;
  const nonStatusFlags = { TF: 1, DF: 1, NT: 1, AC: 1, ID: 1 } as const;

  for (const entry of cases) {
    const producer = ok(decodeBytes(entry.bytes));
    const producerRun = await instantiateIrBlock(blockOf([producer]));
    const lazyFlags = aluReference("add", entry.width, entry.left, entry.right).flags;
    const explicitFlags = oppositeStatusFlags(lazyFlags);

    writeWasmCpuStateSnapshot(producerRun.stateView, {
      eax: entry.left,
      ebx: entry.right,
      esp: 0x40,
      eip: producer.address,
      ...explicitFlags,
      ...nonStatusFlags
    });

    strictEqual(producerRun.run(), irBlockCompleted, `${entry.name} producer`);
    strictEqual(readWasmCpuStateChannel(producerRun.stateView, gprChannel("eax")), 0, `${entry.name} producer eax`);
    assertLazyFlagState(
      producerRun.stateView,
      { kind: "ADD", width: entry.width, a: entry.left, b: entry.right },
      `${entry.name} producer`
    );
    assertStatusFlags(producerRun.stateView, explicitFlags, `${entry.name} producer`);

    const consumer = ok(decodeBytes([0x9c], producer.nextEip)); // pushfd
    const consumerRun = await instantiateIrBlock(blockOf([consumer]));

    writeWasmCpuStateSnapshot(consumerRun.stateView, readWasmCpuStateSnapshot(producerRun.stateView));

    strictEqual(consumerRun.run(), irBlockCompleted, `${entry.name} consumer`);
    strictEqual(consumerRun.guestView.getUint32(0x3c, true), expectedPushfdImage({ ...lazyFlags, ...nonStatusFlags }));
    strictEqual(readWasmCpuStateChannel(consumerRun.stateView, gprChannel("esp")), 0x3c);
    assertStatusFlags(consumerRun.stateView, explicitFlags, `${entry.name} consumer`);
  }
});

test("jcc consumes LOGIC_RESULT records committed by previous logic blocks", async () => {
  const cases = [
    { name: "TEST8 zero", producerBytes: [0xa8, 0x0f], width: 8, eax: 0xf0, result: 0, taken: true },
    { name: "AND16 sign", producerBytes: [0x66, 0x25, 0x00, 0x80], width: 16, eax: 0xffff_8000, result: 0x8000, taken: false },
    { name: "OR32 nonzero", producerBytes: [0x0d, 0x00, 0x01, 0x00, 0x00], width: 32, eax: 0, result: 0x100, taken: false },
    { name: "XOR32 zero", producerBytes: [0x35, 0x78, 0x56, 0x34, 0x12], width: 32, eax: 0x1234_5678, result: 0, taken: true }
  ] as const;

  for (const entry of cases) {
    const producer = ok(decodeBytes(entry.producerBytes));
    const producerRun = await instantiateIrBlock(blockOf([producer]));
    const lazyFlags = aluReference("or", entry.width, entry.result, 0).flags;
    const explicitFlags = oppositeStatusFlags(lazyFlags);

    writeWasmCpuStateSnapshot(producerRun.stateView, {
      eax: entry.eax,
      eip: producer.address,
      ...explicitFlags,
      lazyFlagsB: 0xdead_beef
    });

    strictEqual(producerRun.run(), irBlockCompleted, `${entry.name} producer`);
    assertLazyFlagState(
      producerRun.stateView,
      { kind: "LOGIC_RESULT", width: entry.width, a: entry.result },
      `${entry.name} producer`
    );
    strictEqual(
      readWasmCpuStateSnapshot(producerRun.stateView).lazyFlagsB,
      0xdead_beef,
      `${entry.name} producer lazy B`
    );
    assertStatusFlags(producerRun.stateView, explicitFlags, `${entry.name} producer`);

    const consumer = ok(decodeBytes([0x74, 0x20], producer.nextEip)); // je +0x20
    const consumerRun = await instantiateIrBlock(blockOf([consumer]));

    writeWasmCpuStateSnapshot(consumerRun.stateView, readWasmCpuStateSnapshot(producerRun.stateView));

    strictEqual(consumerRun.run(), irBlockCompleted, `${entry.name} consumer`);
    strictEqual(
      readWasmCpuStateChannel(consumerRun.stateView, eipChannel),
      entry.taken ? relTarget(consumer) : consumer.nextEip,
      `${entry.name} consumer eip`
    );
    assertStatusFlags(consumerRun.stateView, explicitFlags, `${entry.name} consumer`);
  }
});

test("pushfd consumes a LOGIC_RESULT record committed by a previous logic block", async () => {
  const producer = ok(decodeBytes([0x35, 0x78, 0x56, 0x34, 0x12])); // xor eax, 0x12345678
  const producerRun = await instantiateIrBlock(blockOf([producer]));
  const lazyFlags = aluReference("xor", 32, 0x1234_5678, 0x1234_5678).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);
  const nonStatusFlags = { TF: 1, DF: 1, NT: 1, AC: 1, ID: 1 } as const;

  writeWasmCpuStateSnapshot(producerRun.stateView, {
    eax: 0x1234_5678,
    esp: 0x40,
    eip: producer.address,
    ...explicitFlags,
    ...nonStatusFlags,
    lazyFlagsB: 0xdead_beef
  });

  strictEqual(producerRun.run(), irBlockCompleted, "logic pushfd producer");
  strictEqual(readWasmCpuStateChannel(producerRun.stateView, gprChannel("eax")), 0, "logic pushfd producer eax");
  assertLazyFlagState(producerRun.stateView, { kind: "LOGIC_RESULT", width: 32, a: 0 }, "logic pushfd producer");
  strictEqual(readWasmCpuStateSnapshot(producerRun.stateView).lazyFlagsB, 0xdead_beef, "logic pushfd producer lazy B");
  assertStatusFlags(producerRun.stateView, explicitFlags, "logic pushfd producer");

  const consumer = ok(decodeBytes([0x9c], producer.nextEip)); // pushfd
  const consumerRun = await instantiateIrBlock(blockOf([consumer]));

  writeWasmCpuStateSnapshot(consumerRun.stateView, readWasmCpuStateSnapshot(producerRun.stateView));

  strictEqual(consumerRun.run(), irBlockCompleted, "logic pushfd consumer");
  strictEqual(consumerRun.guestView.getUint32(0x3c, true), expectedPushfdImage({ ...lazyFlags, ...nonStatusFlags }));
  strictEqual(readWasmCpuStateChannel(consumerRun.stateView, gprChannel("esp")), 0x3c);
  assertStatusFlags(consumerRun.stateView, explicitFlags, "logic pushfd consumer");
});

test("jcc consumes a SUB32 record committed by a previous cmp block", async () => {
  const producer = ok(decodeBytes([0x39, 0xd8])); // cmp eax, ebx
  const producerRun = await instantiateIrBlock(blockOf([producer]));
  const explicitFlags = oppositeStatusFlags(aluReference("cmp", 32, 0x1234_5678, 0x1234_5678).flags);

  writeWasmCpuStateSnapshot(producerRun.stateView, {
    eax: 0x1234_5678,
    ebx: 0x1234_5678,
    eip: producer.address,
    ...explicitFlags
  });

  strictEqual(producerRun.run(), irBlockCompleted);
  assertLazyFlagState(producerRun.stateView, { kind: "SUB", width: 32, a: 0x1234_5678, b: 0x1234_5678 }, "cmp32 producer");
  assertStatusFlags(producerRun.stateView, explicitFlags, "cmp32 producer");

  const consumer = ok(decodeBytes([0x74, 0x20], producer.nextEip)); // je +0x20
  const consumerRun = await instantiateIrBlock(blockOf([consumer]));

  writeWasmCpuStateSnapshot(consumerRun.stateView, readWasmCpuStateSnapshot(producerRun.stateView));

  strictEqual(consumerRun.run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(consumerRun.stateView, eipChannel), relTarget(consumer), "cmp32 consumer eip");
  assertStatusFlags(consumerRun.stateView, explicitFlags, "cmp32 consumer");
});

test("setcc consumes a SUB16 record committed by a previous sub block", async () => {
  const producer = ok(decodeBytes([0x66, 0x29, 0xd8])); // sub ax, bx
  const producerRun = await instantiateIrBlock(blockOf([producer]));
  const lazyFlags = aluReference("sub", 16, 0, 1).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);

  writeWasmCpuStateSnapshot(producerRun.stateView, {
    eax: 0,
    ebx: 1,
    eip: producer.address,
    ...explicitFlags
  });

  strictEqual(producerRun.run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(producerRun.stateView, gprChannel("eax")), 0xffff);
  assertLazyFlagState(producerRun.stateView, { kind: "SUB", width: 16, a: 0, b: 1 }, "sub16 producer");
  assertStatusFlags(producerRun.stateView, explicitFlags, "sub16 producer");

  const consumer = ok(decodeBytes([0x0f, 0x96, 0xc0], producer.nextEip)); // setbe al
  const consumerRun = await instantiateIrBlock(blockOf([consumer]));

  writeWasmCpuStateSnapshot(consumerRun.stateView, readWasmCpuStateSnapshot(producerRun.stateView));

  strictEqual(consumerRun.run(), irBlockCompleted);
  strictEqual(
    readWasmCpuStateChannel(consumerRun.stateView, gprChannel("eax")),
    0xff00 + (evaluateCondition(CONDITIONS.BE.expr, flagSet(lazyFlags)) ? 1 : 0),
    "sub16 consumer eax"
  );
  assertStatusFlags(consumerRun.stateView, explicitFlags, "sub16 consumer");
});

test("pushfd consumes a SUB8 record committed by a previous cmp block", async () => {
  const producer = ok(decodeBytes([0x3c, 0x80])); // cmp al, 0x80
  const producerRun = await instantiateIrBlock(blockOf([producer]));
  const lazyFlags = aluReference("cmp", 8, 0x80, 0x80).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);
  const nonStatusFlags = { TF: 1, DF: 1, NT: 1, AC: 1, ID: 1 } as const;

  writeWasmCpuStateSnapshot(producerRun.stateView, {
    eax: 0x80,
    esp: 0x40,
    eip: producer.address,
    ...explicitFlags,
    ...nonStatusFlags
  });

  strictEqual(producerRun.run(), irBlockCompleted);
  assertLazyFlagState(producerRun.stateView, { kind: "SUB", width: 8, a: 0x80, b: 0x80 }, "cmp8 producer");
  assertStatusFlags(producerRun.stateView, explicitFlags, "cmp8 producer");

  const consumer = ok(decodeBytes([0x9c], producer.nextEip)); // pushfd
  const consumerRun = await instantiateIrBlock(blockOf([consumer]));

  writeWasmCpuStateSnapshot(consumerRun.stateView, readWasmCpuStateSnapshot(producerRun.stateView));

  strictEqual(consumerRun.run(), irBlockCompleted);
  strictEqual(consumerRun.guestView.getUint32(0x3c, true), expectedPushfdImage({ ...lazyFlags, ...nonStatusFlags }));
  strictEqual(readWasmCpuStateChannel(consumerRun.stateView, gprChannel("esp")), 0x3c);
  assertStatusFlags(consumerRun.stateView, explicitFlags, "cmp8 consumer");
});

test("partial flag writer after incoming SUB record materializes preserved CF", async () => {
  const producer = ok(decodeBytes([0x39, 0xd8])); // cmp eax, ebx
  const producerRun = await instantiateIrBlock(blockOf([producer]));
  const lazyFlags = aluReference("cmp", 32, 0, 1).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);

  writeWasmCpuStateSnapshot(producerRun.stateView, {
    eax: 0,
    ebx: 1,
    ecx: 0xffff_ffff,
    eip: producer.address,
    ...explicitFlags
  });

  strictEqual(producerRun.run(), irBlockCompleted);
  assertLazyFlagState(producerRun.stateView, { kind: "SUB", width: 32, a: 0, b: 1 }, "partial producer");
  assertStatusFlags(producerRun.stateView, explicitFlags, "partial producer");

  const consumer = ok(decodeBytes([0x41], producer.nextEip)); // inc ecx
  const consumerRun = await instantiateIrBlock(blockOf([consumer]));

  writeWasmCpuStateSnapshot(consumerRun.stateView, readWasmCpuStateSnapshot(producerRun.stateView));

  strictEqual(consumerRun.run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(consumerRun.stateView, gprChannel("ecx")), 0, "partial consumer ecx");
  strictEqual(readWasmCpuStateChannel(consumerRun.stateView, eipChannel), consumer.nextEip, "partial consumer eip");
  assertStatusFlags(
    consumerRun.stateView,
    { CF: lazyFlags.CF, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 },
    "partial consumer"
  );
  assertLazyFlagState(consumerRun.stateView, { kind: "NONE", width: 0 }, "partial consumer");
});

test("partial flag writer after incoming ADD record materializes preserved CF", async () => {
  const producer = ok(decodeBytes([0x01, 0xd8])); // add eax, ebx
  const producerRun = await instantiateIrBlock(blockOf([producer]));
  const lazyFlags = aluReference("add", 32, 0xffff_ffff, 1).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);

  writeWasmCpuStateSnapshot(producerRun.stateView, {
    eax: 0xffff_ffff,
    ebx: 1,
    ecx: 0xffff_ffff,
    eip: producer.address,
    ...explicitFlags
  });

  strictEqual(producerRun.run(), irBlockCompleted);
  assertLazyFlagState(producerRun.stateView, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 }, "partial add producer");
  assertStatusFlags(producerRun.stateView, explicitFlags, "partial add producer");

  const consumer = ok(decodeBytes([0x41], producer.nextEip)); // inc ecx
  const consumerRun = await instantiateIrBlock(blockOf([consumer]));

  writeWasmCpuStateSnapshot(consumerRun.stateView, readWasmCpuStateSnapshot(producerRun.stateView));

  strictEqual(consumerRun.run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(consumerRun.stateView, gprChannel("ecx")), 0, "partial add consumer ecx");
  strictEqual(readWasmCpuStateChannel(consumerRun.stateView, eipChannel), consumer.nextEip, "partial add consumer eip");
  assertStatusFlags(
    consumerRun.stateView,
    { CF: lazyFlags.CF, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 },
    "partial add consumer"
  );
  assertLazyFlagState(consumerRun.stateView, { kind: "NONE", width: 0 }, "partial add consumer");
});

test("partial flag writer after incoming LOGIC_RESULT record materializes preserved CF", async () => {
  const entry = { width: 32, result: 0x8000_0000 } as const;
  const lazyFlags = aluReference("or", entry.width, entry.result, 0).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);
  const consumer = ok(decodeBytes([0x41])); // inc ecx
  const { stateView, run } = await instantiateIrBlock(blockOf([consumer]));

  writeWasmCpuStateSnapshot(stateView, {
    ecx: 0xffff_ffff,
    eip: consumer.address,
    ...logicLazyFlagsState(entry),
    ...explicitFlags
  });

  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 0, "partial logic consumer ecx");
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), consumer.nextEip, "partial logic consumer eip");
  assertStatusFlags(
    stateView,
    { CF: lazyFlags.CF, PF: 1, AF: 1, ZF: 1, SF: 0, OF: 0 },
    "partial logic consumer"
  );
  assertLazyFlagState(stateView, { kind: "NONE", width: 0 }, "partial logic consumer");
});

function setbeBlock(): IrBlock {
  return blockOf([ok(decodeBytes([0x0f, 0x96, 0xc0]))]);
}

async function producedSubState(
  entry: BinaryLazyFlagsCase,
  explicitFlags: AluFlags
): Promise<ReturnType<typeof readWasmCpuStateSnapshot>> {
  const instruction = ok(decodeBytes(cmpRegBytes(entry.width)));
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));
  const maskedLeft = (entry.left & widthMask(entry.width)) >>> 0;
  const maskedRight = (entry.right & widthMask(entry.width)) >>> 0;

  writeWasmCpuStateSnapshot(stateView, {
    eax: entry.left,
    ebx: entry.right,
    eip: instruction.address,
    ...explicitFlags
  });

  strictEqual(run(), irBlockCompleted, `produce SUB${entry.width} lazy state`);
  assertLazyFlagState(
    stateView,
    { kind: "SUB", width: entry.width, a: maskedLeft, b: maskedRight },
    `produce SUB${entry.width} lazy state`
  );
  assertStatusFlags(stateView, explicitFlags, `produce SUB${entry.width} lazy state`);
  return readWasmCpuStateSnapshot(stateView);
}

async function assertJccReadsLazySub(
  cc: ConditionCode,
  entry: BinaryLazyFlagsCase,
  state: ReturnType<typeof readWasmCpuStateSnapshot> | Record<string, number>,
  address: number,
  label: string
): Promise<void> {
  const instruction = ok(decodeBytes(jccBytes(cc), address));
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));
  const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);
  const taken = conditionValue(cc, lazyFlags);

  writeWasmCpuStateSnapshot(stateView, {
    ...state,
    eip: instruction.address
  });

  strictEqual(run(), irBlockCompleted, `${label} jcc`);
  strictEqual(
    readWasmCpuStateChannel(stateView, eipChannel),
    taken ? relTarget(instruction) : instruction.nextEip,
    `${label} jcc eip`
  );
  assertStatusFlags(stateView, explicitFlags, `${label} jcc`);
}

async function assertSetccReadsLazySub(
  cc: ConditionCode,
  entry: BinaryLazyFlagsCase,
  state: ReturnType<typeof readWasmCpuStateSnapshot> | Record<string, number>,
  address: number,
  label: string
): Promise<void> {
  const instruction = ok(decodeBytes(setccBytes(cc), address));
  const { stateView, run } = await instantiateIrBlock(blockOf([instruction]));
  const lazyFlags = aluReference("sub", entry.width, entry.left, entry.right).flags;
  const explicitFlags = oppositeStatusFlags(lazyFlags);
  const result = conditionValue(cc, lazyFlags) ? 1 : 0;

  writeWasmCpuStateSnapshot(stateView, {
    ...state,
    eax: 0x55aa_5500,
    eip: instruction.address
  });

  strictEqual(run(), irBlockCompleted, `${label} setcc`);
  strictEqual(
    readWasmCpuStateChannel(stateView, gprChannel("eax")),
    0x55aa_5500 + result,
    `${label} setcc eax`
  );
  assertStatusFlags(stateView, explicitFlags, `${label} setcc`);
}

function conditionValue(cc: ConditionCode, flags: AluFlags): boolean {
  return evaluateCondition(CONDITIONS[cc].expr, flagSet(flags));
}

function jccBytes(cc: ConditionCode): readonly number[] {
  return [0x70 + conditionOpcodeLow(cc), 0x20];
}

function setccBytes(cc: ConditionCode): readonly number[] {
  return [0x0f, 0x90 + conditionOpcodeLow(cc), 0xc0];
}

function conditionOpcodeLow(cc: ConditionCode): number {
  const descriptor = CONDITION_CODE_DESCRIPTORS.find((entry) => entry.cc === cc);

  if (descriptor === undefined) {
    throw new Error(`missing condition descriptor for ${cc}`);
  }

  return descriptor.opcodeLow;
}

function cmpRegBytes(width: OperandWidth): readonly number[] {
  switch (width) {
    case 8:
      return [0x38, 0xd8];
    case 16:
      return [0x66, 0x39, 0xd8];
    case 32:
      return [0x39, 0xd8];
  }
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
      case "segment":
        throw new Error(`unsupported segment operand in lazy flag e2e: ${instruction.spec.id}`);
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

function subLazyFlagsState(entry: BinaryLazyFlagsCase) {
  return {
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, entry.width),
    lazyFlagsA: entry.left,
    lazyFlagsB: entry.right
  };
}

function addLazyFlagsState(entry: BinaryLazyFlagsCase) {
  return {
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.ADD, entry.width),
    lazyFlagsA: entry.left,
    lazyFlagsB: entry.right
  };
}

function logicLazyFlagsState(entry: LogicLazyFlagsCase) {
  return {
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.LOGIC_RESULT, entry.width),
    lazyFlagsA: (entry.result & widthMask(entry.width)) >>> 0,
    lazyFlagsB: 0xdead_beef
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
