import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildIrBlock } from "#engines/jit/action-compiler.js";
import { encodeActionJitModule } from "#engines/jit/action-module.js";
import { compileActionWasmBlockHandle } from "#engines/jit/block-handle.js";
import type { Action, StateSlot } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable } from "#ir/values.js";
import { gprChannel } from "#ir/slots.js";
import { ByteArrayDecodeReader } from "#x86/decoder/tests/helpers.js";
import { decodeIsaBlock, type IsaDecodedBlock } from "#x86/decoder/decode-block.js";
import { ExitReason } from "#wasm/exit.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { readWasmCpuState } from "#runtime/tests/fixtures/cpu-state.js";
import { wasmDefinedFunctionCount } from "#wasm/tests/body-opcodes.js";

const startEip = 0x1000;

test("JIT module emits no helper functions for ordinary blocks", () => {
  const bytes = encodeActionJitModule([{ entryEip: startEip, actions: syntheticBlock(false) }]);

  strictEqual(wasmDefinedFunctionCount(bytes), 1);
});

test("JIT module emits a referenced lazy flag helper before block functions", () => {
  const bytes = encodeActionJitModule([{ entryEip: startEip, actions: syntheticBlock(true) }]);

  strictEqual(wasmDefinedFunctionCount(bytes), 2);
});

test("a repeated add compiles to one eax read and one eax write", () => {
  // add eax, 1; add eax, 1.
  const block = buildIrBlock(decodeBlock([0x83, 0xc0, 0x01, 0x83, 0xc0, 0x01]).instructions);
  const actions = entryActions(block);

  strictEqual(actions.filter((action) => action.kind === "readState" && isEaxWordSlot(action.slot)).length, 1);
  strictEqual(actions.filter((action) => action.kind === "writeState" && isEaxWordSlot(action.slot)).length, 1);
});

test("cross-instruction dead flag and eip writes are absent from the action list", () => {
  // add eax, 1; add eax, 1.
  const block = buildIrBlock(decodeBlock([0x83, 0xc0, 0x01, 0x83, 0xc0, 0x01]).instructions);
  const actions = entryActions(block);
  const flagWrites = actions.flatMap((action) =>
    action.kind === "writeState" && action.slot.kind === "flag" ? [action.slot.flag] : []
  );

  strictEqual(flagWrites.length, 6);
  strictEqual(new Set(flagWrites).size, flagWrites.length);
  strictEqual(actions.filter((action) => action.kind === "writeState" && action.slot.kind === "eip").length, 1);
});

test("a guard fault mid-block reports the faulting eip with earlier state flushed", () => {
  // inc eax; mov eax, [0xff0000] — beyond the one-page guest memory.
  const faultAddress = 0xff_0000;
  const block = decodeBlock([0x40, 0x8b, 0x05, 0x00, 0x00, 0xff, 0x00]);
  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  memories.cpuState.load({ eip: startEip, eax: 5 });

  const run = handle.run();
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: faultAddress, detail: 4 });
  strictEqual(state.eax, 6);
  strictEqual(state.eip, startEip + 1);
  strictEqual(state.instructionCount, 1);
});

test("a static jump to a block in the same module tail-calls it directly", () => {
  const targetEip = startEip + 0x10;
  // inc eax; jmp rel32 to targetEip.
  const first = decodeBlock([0x40, 0xe9, 0x0a, 0x00, 0x00, 0x00]);
  // inc eax; int 0x2e.
  const second = decodeBlock([0x40, 0xcd, 0x2e], targetEip);
  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([first, second], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  strictEqual(handle.moduleLinkTable, undefined);

  memories.cpuState.load({ eip: startEip, eax: 0 });

  const run = handle.run(startEip);
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(state.eax, 2);
  strictEqual(state.eip, targetEip + 3);
  strictEqual(state.instructionCount, 4);
});

test("a dynamic jump target reports DYNAMIC_JUMP and resumes from flushed state", () => {
  // jmp eax.
  const block = decodeBlock([0xff, 0xe0]);
  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  strictEqual(handle.moduleLinkTable, undefined);

  memories.cpuState.load({ eip: startEip, eax: 0x4000 });

  const run = handle.run();
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { exitReason: ExitReason.DYNAMIC_JUMP, payload: 0 });
  strictEqual(state.eip, 0x4000);
  strictEqual(state.instructionCount, 1);
});

function decodeBlock(bytes: readonly number[], eip = startEip): IsaDecodedBlock {
  return decodeIsaBlock(new ByteArrayDecodeReader(Uint8Array.from(bytes), eip), eip);
}

function entryActions(block: IrBlock): readonly Action[] {
  const entry = block.regions.find((region) => region.id === block.entry);

  ok(entry !== undefined && entry.kind === "entry", "expected the IR block entry region");
  return entry.actions;
}

function isEaxWordSlot(slot: StateSlot): boolean {
  return slot.kind === "gpr" && slot.reg === "eax" && slot.byteOffsetInReg === 0 && slot.byteLength === 4;
}

function syntheticBlock(withHelper: boolean): IrBlock {
  const values = new ValueTable();
  const stored = withHelper ? values.addHelperCall({ kind: "lazyFlag", flag: "ZF" }) : values.internConst(7);

  return {
    entry: 0,
    regions: [
      {
        id: 0,
        kind: "entry",
        actions: [
          { kind: "writeState", slot: gprChannel("eax"), value: stored },
          { kind: "exit", reason: "hostTrap" }
        ]
      }
    ],
    values
  };
}
