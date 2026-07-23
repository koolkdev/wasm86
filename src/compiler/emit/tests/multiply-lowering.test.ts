import { strictEqual } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { createInstructionFunction } from "./instruction-function.js";
import { gprChannel } from "#core/state/channels.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { OperandWidth, RegName } from "#core/types.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testFunctionCompleted, instantiateTestFunction } from "./harness.js";

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

function assertCompleted(exit: bigint): void {
  strictEqual(exit, testFunctionCompleted);
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
    const builder = createInstructionFunction();
    const template: SemanticTemplate = (s, v) => {
      const left = v.extend64(entry.width, s.read(s.reg("eax"), { width: 32 }), true);
      const right = v.extend64(entry.width, s.read(s.reg("ebx"), { width: 32 }), true);
      const fullProduct = v.binary64("mul", left, right);
      const truncatedProduct = v.extend64(entry.width, v.truncate64(entry.width, fullProduct), true);
      const truncatedDiffers = v.compare64("ne", fullProduct, truncatedProduct);

      s.write(s.reg("edx"), truncatedDiffers, { width: 32 });
    };

    builder.add(template, [], loc(0x1000, 0x1001));

    const { stateView, run } = await instantiateTestFunction(builder.finish());

    writeWasmCpuStateSnapshot(stateView, { eax: entry.left, ebx: entry.right });
    assertCompleted(run());
    strictEqual(readRegister(stateView, "edx"), entry.truncatedDiffers);
  });
}

test("i32 multiply returns the low product", async () => {
  const builder = createInstructionFunction();
  const template: SemanticTemplate = (s, v) => {
    s.write(s.reg("edx"), v.binary("mul", s.read(s.reg("eax"), { width: 32 }), s.read(s.reg("ebx"), { width: 32 })), { width: 32 });
  };

  builder.add(template, [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const { stateView, run } = await instantiateTestFunction(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0x4000_0000, ebx: 2 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "edx"), 0x8000_0000);
});

test("unsigned dword product returns the high half", async () => {
  const builder = createInstructionFunction();
  const template: SemanticTemplate = (s, v) => {
    const left = v.extend64(32, s.read(s.reg("eax"), { width: 32 }), false);
    const right = v.extend64(32, s.read(s.reg("ebx"), { width: 32 }), false);
    const fullProduct = v.binary64("mul", left, right);
    const high = v.truncate64(32, v.binary64("shr_u", fullProduct, v.extend64(32, v.const(32), false)));

    s.write(s.reg("edx"), high, { width: 32 });
  };

  builder.add(template, [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const { stateView, run } = await instantiateTestFunction(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0xffff_ffff, ebx: 2 });
  assertCompleted(run());
  strictEqual(readRegister(stateView, "edx"), 1);
});
