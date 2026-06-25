import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ExitReason } from "#wasm/exit.js";
import { createWasmHostMemories, type WasmHostMemories } from "#wasm/host/memories.js";
import { assertLazyFlagState, readWasmCpuState, wasmCpuStatusFlagsOf } from "#runtime/tests/fixtures/cpu-state.js";
import { jitModuleLinkFallbackExportName } from "#engines/jit/compiled-blocks/module-link-table.js";
import type { WasmCompiledBlockCodeMap } from "#engines/jit/compiled-blocks/block-cache.js";
import { WasmCompiledBlockCache } from "#engines/jit/compiled-blocks/wasm-cache.js";
import type { WasmBlockHandle } from "#engines/jit/block-handle.js";
import {
  GuestMemoryDecodeReader,
  type GuestMemoryDecodeRegion
} from "#x86/decoder/guest-memory-reader.js";

const aEip = 0x1000;
const bEip = 0x2000;
const cEip = 0x3000;
const noFlags = { CF: 0, PF: 0, AF: 0, ZF: 0, SF: 0, OF: 0 } as const;

test("unlinked final static jmp uses module-local fallback stub", () => {
  const fixture = createLinkingFixture([
    block(aEip, incEaxJmpRel32(aEip, bEip)),
    block(bEip, incEaxHostTrap())
  ]);
  const a = compileBlock(fixture, aEip);
  const slot = slotForTarget(a, bEip);
  const stub = exportedFunction(a, jitModuleLinkFallbackExportName(bEip));

  strictEqual(a.moduleLinkTable?.table.length, 1);
  throws(() => a.moduleLinkTable?.table.grow(1), /maximum|grow/i);
  strictEqual(a.moduleLinkTable?.table.get(slot), stub);

  fixture.memories.cpuState.load({ eip: aEip });

  const run = a.run();
  const state = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(run.exit, { exitReason: ExitReason.LINK_STUB, payload: bEip });
  strictEqual(state.eip, bEip);
  strictEqual(state.eax, 1);
});

test("compiled target patches dependent module-local table", () => {
  const fixture = createLinkingFixture([
    block(aEip, incEaxJmpRel32(aEip, bEip)),
    block(bEip, incEaxHostTrap())
  ]);
  const a = compileBlock(fixture, aEip);
  const b = compileBlock(fixture, bEip);
  const slot = slotForTarget(a, bEip);

  strictEqual(a.moduleLinkTable?.table.get(slot), b.exportedBlockFunctionForEip(bEip));

  fixture.memories.cpuState.load({ eip: aEip });

  const run = a.run();
  const state = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(run.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(state.eax, 2);
});

test("compiled target patches static call through dependent module-local table", () => {
  const fixture = createLinkingFixture([
    block(aEip, incEaxCallRel32(aEip, bEip)),
    block(bEip, incEaxHostTrap())
  ]);
  const a = compileBlock(fixture, aEip);
  const b = compileBlock(fixture, bEip);
  const slot = slotForTarget(a, bEip);

  strictEqual(a.moduleLinkTable?.table.get(slot), b.exportedBlockFunctionForEip(bEip));

  fixture.memories.cpuState.load({ eip: aEip, esp: 0x80 });

  const run = a.run();
  const state = readWasmCpuState(fixture.memories.cpuState);
  const returnAddress = aEip + incEaxCallRel32(aEip, bEip).length;

  deepStrictEqual(run.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(state.eax, 2);
  strictEqual(state.esp, 0x7c);
  strictEqual(new DataView(fixture.memories.guestMemory.buffer).getUint32(0x7c, true), returnAddress);
});

// The pending map folds the moved constant into the jump target, so the
// indirect jump links exactly like a static one.
test("constant-folded indirect jump target links through the module-local table", () => {
  const fixture = createLinkingFixture([
    block(aEip, movEaxJmpEax(bEip)),
    block(bEip, incEaxHostTrap())
  ]);
  const a = compileBlock(fixture, aEip);
  const slot = slotForTarget(a, bEip);

  strictEqual(a.moduleLinkTable?.table.get(slot), exportedFunction(a, jitModuleLinkFallbackExportName(bEip)));

  const b = compileBlock(fixture, bEip);

  strictEqual(a.moduleLinkTable?.table.get(slot), b.exportedBlockFunctionForEip(bEip));

  fixture.memories.cpuState.load({ eip: aEip });

  const run = a.run();
  const state = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(run.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(state.eax, bEip + 1);
  strictEqual(state.eip, bEip + 3);
});

test("final jmp rel8 can link through the module-local table", () => {
  const rel8A = 0x1100;
  const rel8B = 0x1108;
  const fixture = createLinkingFixture([
    block(rel8A, incEaxJmpRel8(rel8A, rel8B)),
    block(rel8B, incEaxHostTrap())
  ]);
  const a = compileBlock(fixture, rel8A);
  const b = compileBlock(fixture, rel8B);
  const slot = slotForTarget(a, rel8B);

  strictEqual(a.moduleLinkTable?.table.get(slot), b.exportedBlockFunctionForEip(rel8B));

  fixture.memories.cpuState.load({ eip: rel8A });

  const run = a.run();
  const state = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(run.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(state.eax, 2);
});

test("compiled conditional targets patch both branch slots", () => {
  const takenEip = aEip + 0x20;
  const branchBytes = incEaxJnzRel8(aEip, takenEip);
  const notTakenEip = aEip + branchBytes.length;
  const fixture = createLinkingFixture([
    block(aEip, branchBytes),
    block(notTakenEip, incEaxHostTrap()),
    block(takenEip, incEaxHostTrap())
  ]);
  const branch = compileBlock(fixture, aEip);
  const notTaken = compileBlock(fixture, notTakenEip);
  const taken = compileBlock(fixture, takenEip);
  const notTakenSlot = slotForTarget(branch, notTakenEip);
  const takenSlot = slotForTarget(branch, takenEip);

  strictEqual(branch.moduleLinkTable?.table.length, 2);
  strictEqual(branch.moduleLinkTable?.table.get(notTakenSlot), notTaken.exportedBlockFunctionForEip(notTakenEip));
  strictEqual(branch.moduleLinkTable?.table.get(takenSlot), taken.exportedBlockFunctionForEip(takenEip));

  fixture.memories.cpuState.load({ eip: aEip });

  const takenRun = branch.run();
  const takenState = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(takenRun.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(takenState.eax, 2);

  fixture.memories.cpuState.load({ eip: aEip, ZF: 1 });

  const notTakenRun = branch.run();
  const notTakenState = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(notTakenRun.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(notTakenState.eax, 2);
});

test("linked conditional branch exits preserve exit-store flag values", () => {
  const takenEip = aEip + 0x20;
  const branchBytes = addEaxOneJnzRel8(aEip, takenEip);
  const notTakenEip = aEip + branchBytes.length;
  const fixture = createLinkingFixture([
    block(aEip, branchBytes),
    block(notTakenEip, hostTrap()),
    block(takenEip, hostTrap())
  ]);
  const branch = compileBlock(fixture, aEip);
  const notTaken = compileBlock(fixture, notTakenEip);
  const taken = compileBlock(fixture, takenEip);
  const notTakenSlot = slotForTarget(branch, notTakenEip);
  const takenSlot = slotForTarget(branch, takenEip);

  strictEqual(branch.moduleLinkTable?.table.get(notTakenSlot), notTaken.exportedBlockFunctionForEip(notTakenEip));
  strictEqual(branch.moduleLinkTable?.table.get(takenSlot), taken.exportedBlockFunctionForEip(takenEip));

  fixture.memories.cpuState.load({ eip: aEip, eax: 0 });

  const takenRun = branch.run();
  const takenState = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(takenRun.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(takenState.eax, 1);
  deepStrictEqual(wasmCpuStatusFlagsOf(takenState), noFlags);
  assertLazyFlagState(takenState, { kind: "ADD", width: 32, a: 0, b: 1 }, "taken");

  fixture.memories.cpuState.load({ eip: aEip, eax: 0xffff_ffff });

  const notTakenRun = branch.run();
  const notTakenState = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(notTakenRun.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(notTakenState.eax, 0);
  deepStrictEqual(wasmCpuStatusFlagsOf(notTakenState), noFlags);
  assertLazyFlagState(notTakenState, { kind: "ADD", width: 32, a: 0xffff_ffff, b: 1 }, "not taken");
});

test("invalidating compiled target restores dependent module-local fallback", () => {
  const fixture = createLinkingFixture([
    block(aEip, incEaxJmpRel32(aEip, bEip)),
    block(bEip, incEaxHostTrap())
  ]);
  const a = compileBlock(fixture, aEip);
  compileBlock(fixture, bEip);

  fixture.cache.invalidate(bEip);

  const slot = slotForTarget(a, bEip);
  const stub = exportedFunction(a, jitModuleLinkFallbackExportName(bEip));

  strictEqual(a.moduleLinkTable?.table.get(slot), stub);

  fixture.memories.cpuState.load({ eip: aEip });

  const run = a.run();
  const state = readWasmCpuState(fixture.memories.cpuState);

  deepStrictEqual(run.exit, { exitReason: ExitReason.LINK_STUB, payload: bEip });
  strictEqual(state.eip, bEip);
  strictEqual(state.eax, 1);
});

test("target compile and invalidation patch multiple dependent module tables", () => {
  const fixture = createLinkingFixture([
    block(aEip, incEaxJmpRel32(aEip, bEip)),
    block(bEip, incEaxHostTrap()),
    block(cEip, incEaxJmpRel32(cEip, bEip))
  ]);
  const a = compileBlock(fixture, aEip);
  const c = compileBlock(fixture, cEip);
  const b = compileBlock(fixture, bEip);
  const aSlot = slotForTarget(a, bEip);
  const cSlot = slotForTarget(c, bEip);

  strictEqual(a.moduleLinkTable?.table.get(aSlot), b.exportedBlockFunctionForEip(bEip));
  strictEqual(c.moduleLinkTable?.table.get(cSlot), b.exportedBlockFunctionForEip(bEip));

  fixture.memories.cpuState.load({ eip: aEip });
  deepStrictEqual(a.run().exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(readWasmCpuState(fixture.memories.cpuState).eax, 2);

  fixture.memories.cpuState.load({ eip: cEip });
  deepStrictEqual(c.run().exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  strictEqual(readWasmCpuState(fixture.memories.cpuState).eax, 2);

  fixture.cache.invalidate(bEip);

  strictEqual(a.moduleLinkTable?.table.get(aSlot), exportedFunction(a, jitModuleLinkFallbackExportName(bEip)));
  strictEqual(c.moduleLinkTable?.table.get(cSlot), exportedFunction(c, jitModuleLinkFallbackExportName(bEip)));

  fixture.memories.cpuState.load({ eip: cEip });
  deepStrictEqual(c.run().exit, { exitReason: ExitReason.LINK_STUB, payload: bEip });
  strictEqual(readWasmCpuState(fixture.memories.cpuState).eax, 1);
});

function createLinkingFixture(blocks: readonly TestBlock[]): Readonly<{
  cache: WasmCompiledBlockCache;
  codeMap: WasmCompiledBlockCodeMap;
  memories: WasmHostMemories;
}> {
  const memories = createWasmHostMemories();
  const regions: GuestMemoryDecodeRegion[] = [];

  for (const testBlock of blocks) {
    regions.push({
      kind: "guest-memory",
      baseAddress: testBlock.eip,
      byteLength: testBlock.bytes.length
    });
    writeGuestBytes(memories, testBlock.eip, testBlock.bytes);
  }

  return {
    cache: new WasmCompiledBlockCache(),
    codeMap: {
      createReader: (memory) => new GuestMemoryDecodeReader(memory, regions)
    },
    memories
  };
}

function compileBlock(fixture: ReturnType<typeof createLinkingFixture>, eip: number): WasmBlockHandle {
  const handle = fixture.cache.getOrCompile(eip, fixture.codeMap, fixture.memories);

  ok(handle, `expected block at 0x${eip.toString(16)} to compile`);

  return handle as WasmBlockHandle;
}

function slotForTarget(handle: WasmBlockHandle, targetEip: number): number {
  const table = handle.moduleLinkTable;

  ok(table, `expected module link table for target 0x${targetEip.toString(16)}`);
  return table.slotForTargetEip(targetEip);
}

function exportedFunction(handle: WasmBlockHandle, name: string): () => unknown {
  const value = handle.instance.exports[name];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${name}'`);
  }

  return value as () => unknown;
}

function writeGuestBytes(memories: WasmHostMemories, eip: number, bytes: readonly number[]): void {
  for (let index = 0; index < bytes.length; index += 1) {
    const write = memories.guest.writeU8(eip + index, bytes[index] ?? 0);

    if (!write.ok) {
      throw new Error(`failed to write guest byte at 0x${(eip + index).toString(16)}`);
    }
  }
}

function block(eip: number, bytes: readonly number[]): TestBlock {
  return { eip, bytes };
}

function incEaxJmpRel32(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...jmpRel32(blockEip + 1, targetEip)
  ];
}

function incEaxCallRel32(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...callRel32(blockEip + 1, targetEip)
  ];
}

function incEaxJmpRel8(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...jmpRel8(blockEip + 1, targetEip)
  ];
}

function incEaxJnzRel8(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x40,
    ...jnzRel8(blockEip + 1, targetEip)
  ];
}

function movEaxJmpEax(targetEip: number): readonly number[] {
  return [
    0xb8,
    targetEip & 0xff,
    (targetEip >>> 8) & 0xff,
    (targetEip >>> 16) & 0xff,
    (targetEip >>> 24) & 0xff,
    0xff, 0xe0
  ];
}

function addEaxOneJnzRel8(blockEip: number, targetEip: number): readonly number[] {
  return [
    0x83, 0xc0, 0x01,
    ...jnzRel8(blockEip + 3, targetEip)
  ];
}

function incEaxHostTrap(): readonly number[] {
  return [
    0x40,
    0xcd, 0x2e
  ];
}

function hostTrap(): readonly number[] {
  return [0xcd, 0x2e];
}

function callRel32(eip: number, targetEip: number): readonly number[] {
  return rel32Instruction(0xe8, eip, targetEip);
}

function jmpRel32(eip: number, targetEip: number): readonly number[] {
  return rel32Instruction(0xe9, eip, targetEip);
}

function jmpRel8(eip: number, targetEip: number): readonly number[] {
  return rel8Instruction(0xeb, eip, targetEip);
}

function jnzRel8(eip: number, targetEip: number): readonly number[] {
  return rel8Instruction(0x75, eip, targetEip);
}

function rel8Instruction(opcode: number, eip: number, targetEip: number): readonly number[] {
  const displacement = targetEip - (eip + 2);

  if (displacement < -128 || displacement > 127) {
    throw new RangeError(`rel8 displacement out of range: ${displacement}`);
  }

  return [
    opcode,
    displacement & 0xff
  ];
}

function rel32Instruction(opcode: number, eip: number, targetEip: number): readonly number[] {
  const displacement = targetEip - (eip + 5);

  return [
    opcode,
    displacement & 0xff,
    (displacement >> 8) & 0xff,
    (displacement >> 16) & 0xff,
    (displacement >> 24) & 0xff
  ];
}

type TestBlock = Readonly<{
  eip: number;
  bytes: readonly number[];
}>;
