import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { RunStop } from "#cpu/cpu.js";
import { decodeExit } from "#cpu/exit.js";
import { CpuExceptionVector } from "#core/exceptions.js";

const validExits: readonly Readonly<{
  name: string;
  encoded: bigint;
  stop: RunStop;
}>[] = [
  {
    name: "instruction-limit",
    encoded: 0x0007_0000_0000_0000n,
    stop: { kind: "instructionLimit" }
  },
  {
    name: "host-trap",
    encoded: 0x0003_0000_0000_00cdn,
    stop: { kind: "hostTrap", vector: 0xcd }
  },
  {
    name: "segment-load",
    encoded: 0x0005_0000_1234_0003n,
    stop: { kind: "segmentLoad", segment: "ds", selector: 0x1234 }
  },
  {
    name: "divide-error",
    encoded: 0x0001_0000_0000_0000n,
    stop: { kind: "cpuException", exception: { kind: "DE" } }
  },
  {
    name: "invalid-opcode",
    encoded: 0x0006_0000_0000_0000n,
    stop: { kind: "cpuException", exception: { kind: "UD" } }
  },
  {
    name: "general-protection",
    encoded: 0x0002_0000_0000_1234n,
    stop: {
      kind: "cpuException",
      exception: { kind: "GP", errorCode: 0x1234 }
    }
  },
  {
    name: "page-fault",
    encoded: 0x0004_8001_ffff_fffcn,
    stop: {
      kind: "cpuException",
      exception: {
        kind: "PF",
        linearAddress: 0xffff_fffc,
        errorCode: 0x8001
      }
    }
  }
];

test("general-protection uses architectural vector 13", () => {
  strictEqual(CpuExceptionVector.GP, 13);
});

for (const fixture of validExits) {
  test(`Cpu exit decoder classifies ${fixture.name}`, () => {
    deepStrictEqual(decodeExit(fixture.encoded), fixture.stop);
  });
}

test("Cpu exit decoder rejects zero, unknown tags, and noncanonical payload bits", () => {
  throws(() => decodeExit(0n), /unknown cpu.exit variant tag: 0/);
  throws(
    () => decodeExit(0x00ff_0000_0000_0000n),
    /unknown cpu.exit variant tag/
  );
  throws(
    () => decodeExit(0x0007_0000_0000_0001n),
    /nonzero unused payload bits/
  );
});

test("Cpu exit decoder rejects a segment-load request with an invalid architectural index", () => {
  throws(
    () => decodeExit(0x0005_0000_1234_00ffn),
    /invalid segment index/
  );
});
