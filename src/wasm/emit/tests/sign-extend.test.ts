import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { createLegacyInstructionBlock } from "#test/support/legacy-instruction-block.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import {
  readWasmCpuStateChannel,
  readWasmCpuStateSnapshot,
  type WasmCpuStateInit,
  wasmCpuStatusFlagsOf,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { decodeBytes, ok as decoded } from "#core/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import type { RegName } from "#core/types.js";
import { irBlockCompleted, instantiateIrBlock } from "./harness.js";

const allFlagsSet = { CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 } as const;

function readRegister(view: DataView, name: RegName): number {
  return readWasmCpuStateChannel(view, gprChannel(name));
}

function assertCompleted(exit: bigint): void {
  strictEqual(exit, irBlockCompleted);
}

test("decoded CBW and CWDE sign-extend into the accumulator without touching flags", async () => {
  const cbw = await runDecoded([0x66, 0x98], { eax: 0xaaaa_0080, ...allFlagsSet });
  const cwde = await runDecoded([0x98], { eax: 0xaaaa_8000, ...allFlagsSet });

  strictEqual(readRegister(cbw.stateView, "eax"), 0xaaaa_ff80);
  strictEqual(readWasmCpuStateChannel(cbw.stateView, coreStateFields.eip), cbw.instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(cbw.stateView)), allFlagsSet);

  strictEqual(readRegister(cwde.stateView, "eax"), 0xffff_8000);
  strictEqual(readWasmCpuStateChannel(cwde.stateView, coreStateFields.eip), cwde.instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(cwde.stateView)), allFlagsSet);
});

test("decoded CWD and CDQ sign-extend into the high accumulator without touching flags", async () => {
  const cwd = await runDecoded([0x66, 0x99], {
    eax: 0xaaaa_8000,
    edx: 0xbbbb_1234,
    ...allFlagsSet
  });
  const cdq = await runDecoded([0x99], {
    eax: 0x8000_0000,
    edx: 0x1234_5678,
    ...allFlagsSet
  });

  strictEqual(readRegister(cwd.stateView, "eax"), 0xaaaa_8000);
  strictEqual(readRegister(cwd.stateView, "edx"), 0xbbbb_ffff);
  strictEqual(readWasmCpuStateChannel(cwd.stateView, coreStateFields.eip), cwd.instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(cwd.stateView)), allFlagsSet);

  strictEqual(readRegister(cdq.stateView, "eax"), 0x8000_0000);
  strictEqual(readRegister(cdq.stateView, "edx"), 0xffff_ffff);
  strictEqual(readWasmCpuStateChannel(cdq.stateView, coreStateFields.eip), cdq.instruction.nextEip);
  deepStrictEqual(wasmCpuStatusFlagsOf(readWasmCpuStateSnapshot(cdq.stateView)), allFlagsSet);
});

async function runDecoded(
  bytes: readonly number[],
  initialState: WasmCpuStateInit
) {
  const instruction = decoded(decodeBytes(bytes));
  const block = blockOf(instruction);
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { ...initialState, eip: instruction.address });
  assertCompleted(run());

  return { instruction, stateView };
}

function blockOf(instruction: IsaDecodedInstruction) {
  const builder = createLegacyInstructionBlock();

  builder.add(instruction.spec.semantics, [], loc(instruction.address, instruction.nextEip));
  return builder.finish();
}
