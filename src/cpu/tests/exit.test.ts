import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { RunStop } from "#cpu/cpu.js";
import { decodeExit, exitLayout } from "#cpu/exit.js";
import { encodeVariant, type VariantValue } from "#compiler/layout/variant-codec.js";
import {
  exceptionExit,
  segmentExit,
  trapExit
} from "#core/exits.js";
import {
  CpuExceptionVector,
  divideError,
  generalProtection,
  invalidOpcode,
  pageFault
} from "#core/exceptions.js";
import { instructionLimitExit } from "#interpreter/exits.js";

const validExits: readonly Readonly<{
  name: string;
  exit: VariantValue<number>;
  stop: RunStop;
}>[] = [
  {
    name: "instruction-limit",
    exit: instructionLimitExit(),
    stop: { kind: "instructionLimit" }
  },
  {
    name: "host-trap",
    exit: trapExit(0xcd),
    stop: { kind: "hostTrap", vector: 0xcd }
  },
  {
    name: "segment-load",
    exit: segmentExit(3, 0x1234),
    stop: { kind: "segmentLoad", segment: "ds", selector: 0x1234 }
  },
  {
    name: "divide-error",
    exit: exceptionExit(divideError<number>()),
    stop: { kind: "cpuException", exception: divideError() }
  },
  {
    name: "invalid-opcode",
    exit: exceptionExit(invalidOpcode<number>()),
    stop: { kind: "cpuException", exception: invalidOpcode() }
  },
  {
    name: "general-protection",
    exit: exceptionExit(generalProtection(0x1234)),
    stop: { kind: "cpuException", exception: generalProtection(0x1234) }
  },
  {
    name: "page-fault",
    exit: exceptionExit(pageFault(0xffff_fffc, 0x8001)),
    stop: {
      kind: "cpuException",
      exception: pageFault(0xffff_fffc, 0x8001)
    }
  }
];

test("general-protection uses architectural vector 13", () => {
  strictEqual(CpuExceptionVector.GP, 13);
});

for (const fixture of validExits) {
  test(`Cpu exit decoder classifies ${fixture.name}`, () => {
    const encoded = encodeVariant(exitLayout, fixture.exit);

    deepStrictEqual(decodeExit(encoded), fixture.stop);
  });
}

test("Cpu exit decoder rejects zero, unknown tags, and noncanonical payload bits", () => {
  const instructionLimit = encodeVariant(
    exitLayout,
    instructionLimitExit()
  );
  const unknownTag = 0xffn << BigInt(exitLayout.tagOffset * 8);

  throws(() => decodeExit(0n), /unknown cpu.exit variant tag: 0/);
  throws(() => decodeExit(unknownTag), /unknown cpu.exit variant tag/);
  throws(
    () => decodeExit(instructionLimit | 1n),
    /nonzero unused payload bits/
  );
});

test("Cpu exit decoder rejects a segment-load request with an invalid architectural index", () => {
  const encoded = encodeVariant(exitLayout, segmentExit(0xff, 0x1234));

  throws(() => decodeExit(encoded), /invalid segment index/);
});
