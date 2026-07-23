import { strictEqual } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import {
  immBinding,
  regBinding,
  type OperandBinding
} from "#core/instruction/bindings.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import {
  x86StatusFlags,
  type X86StatusFlag
} from "#core/flags/definitions.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import {
  assertLazyFlagState,
  readWasmCpuFlagByte,
  readWasmCpuStateChannel,
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { decodeBytes } from "#test/support/isa-decode.js";
import { createInstructionFunction } from "./instruction-function.js";
import {
  instantiateTestFunction,
  testFunctionCompleted
} from "./harness.js";

type StatusFlags = Readonly<Record<X86StatusFlag, 0 | 1>>;

const allFlagsClear: StatusFlags = {
  CF: 0,
  PF: 0,
  AF: 0,
  ZF: 0,
  SF: 0,
  OF: 0
};

test("setbe reads an incoming SUB record and ignores stale operands for NONE", async () => {
  const decoded = decodeBytes([0x0f, 0x96, 0xc0]);

  assert(decoded.kind === "instruction", "setbe did not decode");
  const instruction = decoded.instruction;
  const { stateView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0x55aa_5500,
    eip: instruction.address,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, 32),
    lazyFlagsA: 3,
    lazyFlagsB: 5,
    ...allFlagsClear
  });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(
    readWasmCpuStateChannel(stateView, gprChannel("eax")),
    0x55aa_5501
  );
  assertLazyFlagState(
    stateView,
    { kind: "SUB", width: 32, a: 3, b: 5 },
    "setbe lazy SUB"
  );
  assertStatusFlags(stateView, allFlagsClear, "setbe lazy SUB");

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0x55aa_55ff,
    eip: instruction.address,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.NONE, 0),
    // These stale operands still describe 3 - 5, but NONE must use the
    // concrete CF/ZF bytes instead.
    lazyFlagsA: 3,
    lazyFlagsB: 5,
    ...allFlagsClear
  });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(
    readWasmCpuStateChannel(stateView, gprChannel("eax")),
    0x55aa_5500
  );
  assertLazyFlagState(
    stateView,
    { kind: "NONE", width: 0 },
    "setbe concrete fallback"
  );
});

test("a CMP lazy record survives into a later Jcc block", async () => {
  const producerResult = decodeBytes([0x39, 0xd8]); // cmp eax, ebx

  assert(producerResult.kind === "instruction", "cmp did not decode");
  const producer = producerResult.instruction;
  const producerRun = await instantiateTestFunction(blockOf([producer]));
  const staleConcrete: StatusFlags = {
    CF: 1,
    PF: 0,
    AF: 1,
    ZF: 0,
    SF: 1,
    OF: 1
  };

  writeWasmCpuStateSnapshot(producerRun.stateView, {
    eax: 0x1234_5678,
    ebx: 0x1234_5678,
    eip: producer.address,
    ...staleConcrete
  });
  strictEqual(producerRun.run(), testFunctionCompleted);
  assertLazyFlagState(
    producerRun.stateView,
    {
      kind: "SUB",
      width: 32,
      a: 0x1234_5678,
      b: 0x1234_5678
    },
    "cmp producer"
  );
  assertStatusFlags(producerRun.stateView, staleConcrete, "cmp producer");

  const consumerResult = decodeBytes([0x74, 0x20], producer.nextEip); // je +0x20

  assert(consumerResult.kind === "instruction", "je did not decode");
  const consumer = consumerResult.instruction;
  const consumerRun = await instantiateTestFunction(blockOf([consumer]));

  writeWasmCpuStateSnapshot(
    consumerRun.stateView,
    readWasmCpuStateSnapshot(producerRun.stateView)
  );
  strictEqual(consumerRun.run(), testFunctionCompleted);
  strictEqual(
    readWasmCpuStateChannel(consumerRun.stateView, coreStateFields.eip),
    0x1024
  );
  assertLazyFlagState(
    consumerRun.stateView,
    {
      kind: "SUB",
      width: 32,
      a: 0x1234_5678,
      b: 0x1234_5678
    },
    "je consumer"
  );
  assertStatusFlags(consumerRun.stateView, staleConcrete, "je consumer");
});

test("JNE resolves an incoming LOGIC_RESULT record", async () => {
  const decoded = decodeBytes([0x75, 0x20]); // jne +0x20

  assert(decoded.kind === "instruction", "jne did not decode");
  const instruction = decoded.instruction;
  const { stateView, run } = await instantiateTestFunction(blockOf([instruction]));
  const staleConcrete: StatusFlags = {
    CF: 1,
    PF: 0,
    AF: 1,
    ZF: 1,
    SF: 0,
    OF: 1
  };

  writeWasmCpuStateSnapshot(stateView, {
    eip: instruction.address,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, 32),
    lazyFlagsA: 0x8000_0000,
    lazyFlagsB: 0xdead_beef,
    ...staleConcrete
  });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(
    readWasmCpuStateChannel(stateView, coreStateFields.eip),
    0x1022
  );
  assertStatusFlags(stateView, staleConcrete, "jne logic record");
});

test("PUSHFD resolves an incoming ADD record into the stack image", async () => {
  const decoded = decodeBytes([0x9c]);

  assert(decoded.kind === "instruction", "pushfd did not decode");
  const instruction = decoded.instruction;
  const { stateView, guestView, run } = await instantiateTestFunction(
    blockOf([instruction])
  );
  const staleConcrete: StatusFlags = {
    CF: 0,
    PF: 0,
    AF: 0,
    ZF: 0,
    SF: 1,
    OF: 1
  };

  writeWasmCpuStateSnapshot(stateView, {
    esp: 0x40,
    eip: instruction.address,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.ADD, 32),
    lazyFlagsA: 0xffff_ffff,
    lazyFlagsB: 1,
    TF: 1,
    DF: 1,
    NT: 1,
    AC: 1,
    ID: 1,
    ...staleConcrete
  });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(guestView.getUint32(0x3c, true), 0x0024_4757);
  strictEqual(
    readWasmCpuStateChannel(stateView, gprChannel("esp")),
    0x3c
  );
  assertStatusFlags(stateView, staleConcrete, "pushfd lazy ADD");
});

test("a partial flag writer flushes the preserved CF from a lazy record", async () => {
  const decoded = decodeBytes([0x41]); // inc ecx

  assert(decoded.kind === "instruction", "inc did not decode");
  const instruction = decoded.instruction;
  const { stateView, run } = await instantiateTestFunction(blockOf([instruction]));

  writeWasmCpuStateSnapshot(stateView, {
    ecx: 0xffff_ffff,
    eip: instruction.address,
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, 32),
    lazyFlagsA: 0,
    lazyFlagsB: 1,
    ...allFlagsClear
  });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(
    readWasmCpuStateChannel(stateView, gprChannel("ecx")),
    0
  );
  assertStatusFlags(stateView, {
    CF: 1,
    PF: 1,
    AF: 1,
    ZF: 1,
    SF: 0,
    OF: 0
  }, "inc flush");
  assertLazyFlagState(
    stateView,
    { kind: "NONE", width: 0 },
    "inc flush"
  );
});

function blockOf(instructions: readonly IsaDecodedInstruction[]) {
  const builder = createInstructionFunction();

  for (const instruction of instructions) {
    builder.add(
      instruction.spec.semantics,
      bindingsFor(instruction),
      loc(instruction.address, instruction.nextEip)
    );
  }
  return builder.finish();
}

function bindingsFor(
  instruction: IsaDecodedInstruction
): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    switch (operand.kind) {
      case "reg":
        return regBinding(operand.alias.name);
      case "imm":
        return immBinding(operand.value);
      case "relTarget":
        return immBinding(operand.target);
      case "segment":
      case "mem":
        throw new Error(
          `unsupported ${operand.kind} operand in lazy flag e2e`
        );
    }
  });
}

function assertStatusFlags(
  stateView: DataView,
  expected: StatusFlags,
  label: string
): void {
  for (const flag of x86StatusFlags) {
    strictEqual(
      readWasmCpuFlagByte(stateView, flag),
      expected[flag],
      `${label} ${flag}`
    );
  }
}
