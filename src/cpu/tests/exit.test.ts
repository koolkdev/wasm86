import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { RunStop } from "#cpu/cpu.js";
import { decodeExit, exitLayout } from "#cpu/exit.js";
import { encodeVariant, type VariantValue } from "#compiler/layout/variant-codec.js";
import {
  deExit,
  pfExit,
  segmentExit,
  trapExit,
  udExit
} from "#core/exits.js";
import { divideError, invalidOpcode, pageFault } from "#core/exceptions.js";
import {
  budgetExit,
  missExit
} from "#engines/interpreter/exits.js";
import { encodeTransfer } from "#engines/jit/legacy-transfer.js";

const validExits: readonly Readonly<{
  name: string;
  exit: VariantValue<number>;
  stop: RunStop;
}>[] = [
  {
    name: "instruction-limit",
    exit: budgetExit(),
    stop: { kind: "instructionLimit" }
  },
  {
    name: "host-trap",
    exit: trapExit(0xcd),
    stop: { kind: "hostTrap", vector: 0xcd }
  },
  {
    name: "unsupported-opcode",
    exit: missExit(),
    stop: { kind: "unsupported", reason: "unsupportedOpcode" }
  },
  {
    name: "segment-load",
    exit: segmentExit(3, 0x1234),
    stop: { kind: "segmentLoad", segment: "ds", selector: 0x1234 }
  },
  {
    name: "divide-error",
    exit: deExit(),
    stop: { kind: "cpuException", exception: divideError() }
  },
  {
    name: "invalid-opcode",
    exit: udExit(),
    stop: { kind: "cpuException", exception: invalidOpcode() }
  },
  {
    name: "page-fault",
    exit: pfExit(0xffff_fffc, 0x8001),
    stop: {
      kind: "cpuException",
      exception: pageFault(0xffff_fffc, 0x8001)
    }
  }
];

for (const fixture of validExits) {
  test(`Cpu exit decodes ${fixture.name}`, () => {
    const encoded = encodeVariant(exitLayout, fixture.exit);

    deepStrictEqual(decodeExit(encoded), fixture.stop);
  });
}

test("Cpu exit rejects zero, unknown tags, and noncanonical payload bits", () => {
  const instructionLimit = encodeVariant(
    exitLayout,
    budgetExit()
  );
  const unknownTag = 0xffn << BigInt(exitLayout.tagOffset * 8);

  throws(() => decodeExit(0n), /unknown cpu.exit variant tag: 0/);
  throws(() => decodeExit(unknownTag), /unknown cpu.exit variant tag/);
  throws(
    () => decodeExit(instructionLimit | 1n),
    /nonzero unused payload bits/
  );
});

test("Cpu exit rejects a segment-load request with an invalid architectural index", () => {
  const encoded = encodeVariant(exitLayout, segmentExit(0xff, 0x1234));

  throws(() => decodeExit(encoded), /invalid segment index/);
});

test("legacy JIT transfers are not Cpu exits", () => {
  for (const encoded of [
    encodeTransfer({ kind: "dynamicJump" }),
    encodeTransfer({ kind: "linkStub", targetEip: 0x1234 })
  ]) {
    throws(() => decodeExit(encoded), /unknown cpu.exit variant tag: 0/);
  }
});
