import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { buildIrBlock } from "#engines/jit/action-compiler.js";
import { encodeJitModule } from "#engines/jit/module.js";
import { compileActionWasmBlockHandle } from "#engines/jit/block-handle.js";
import type { Action } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { flagStateFields } from "#core/flags/layout.js";
import type { InstructionStateChannel } from "#core/instruction/state/channels.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { ByteArrayDecodeReader } from "#core/decoder/tests/helpers.js";
import { decodeIsaBlock, type IsaDecodedBlock } from "#core/decoder/decode-block.js";
import { invalidOpcode, pageFault } from "#core/exceptions.js";
import {
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";
import {
  extractOnlyWasmFunctionBody,
  wasmBodyOpcodes,
  wasmDefinedFunctionCount
} from "#compiler/encoder/tests/body-opcodes.js";
import {
  stateEffect,
  stateWrite,
  stateWriteValue,
  isStateRead,
  isStateWrite
} from "#core/instruction/tests/state-actions.js";
import { covers } from "#ir/aliasing.js";
import { buildExit } from "#cpu/exit.js";
import { trapExit } from "#core/exits.js";
import { cpuStatusFlagResolvers } from "#cpu/state.js";
import { x86Flags } from "#core/flags/definitions.js";

const startEip = 0x1000;

test("JIT module emits no resolver functions for ordinary blocks", () => {
  const bytes = encodeJitModule([{ entryEip: startEip, ir: syntheticBlock(false) }]);

  strictEqual(wasmDefinedFunctionCount(bytes), 1);
});

test("JIT module emits a referenced status-flag resolver", () => {
  const bytes = encodeJitModule([{ entryEip: startEip, ir: syntheticBlock(true) }]);

  strictEqual(wasmDefinedFunctionCount(bytes), 2);
});

test("JIT module includes resolver members reached by input flag reads", () => {
  // seta al reads CF and ZF when there is no same-block flag source; int
  // terminates the block so the test does not need a fallthrough link target.
  const block = buildIrBlock(decodeBlock([0x0f, 0x97, 0xc0, 0xcd, 0x2e]).instructions);
  const bytes = encodeJitModule([{ entryEip: startEip, ir: block }]);

  strictEqual(wasmDefinedFunctionCount(bytes), 3);
});

test("JIT program closure rejects duplicate normalized block identities", () => {
  const actions = syntheticBlock(false);

  throws(
    () => encodeJitModule([
      { entryEip: startEip, ir: actions },
      { entryEip: startEip + 0x1_0000_0000, ir: actions }
    ]),
    /duplicate JIT block module entry EIP/
  );
});

test("JIT program closure rejects an undeclared external link", () => {
  throws(
    () => encodeJitModule([{
      entryEip: startEip,
      ir: syntheticDispatchBlock(startEip + 0x100)
    }]),
    /unknown JIT link target/
  );
});

test("JIT program validates external link layouts before declaration", () => {
  const targetEip = startEip + 0x100;
  const blocks = [{ entryEip: startEip, ir: syntheticDispatchBlock(targetEip) }];

  throws(
    () => encodeJitModule(blocks, { linkLayout: new Map([[targetEip, -1]]) }),
    /invalid JIT link slot/
  );
  throws(
    () => encodeJitModule(blocks, { linkLayout: new Map([[targetEip, 1]]) }),
    /JIT link slot out of range/
  );
  throws(
    () => encodeJitModule(blocks, {
      linkLayout: new Map([[targetEip, 0], [targetEip + 1, 0]])
    }),
    /duplicate JIT link slot/
  );
});

test("a repeated add compiles to one eax read and one eax write", () => {
  // add eax, 1; add eax, 1.
  const block = buildIrBlock(decodeBlock([0x83, 0xc0, 0x01, 0x83, 0xc0, 0x01]).instructions);
  const actions = entryActions(block);

  strictEqual(actions.filter((action) =>
    isStateRead(action) && accessesChannel(block, action, gprChannel("eax"))
  ).length, 1);
  strictEqual(actions.filter((action) =>
    isStateWrite(action) && accessesChannel(block, action, gprChannel("eax"))
  ).length, 1);
});

test("cross-instruction dead flag writes are absent and Core commits EIP before dispatch", () => {
  // add eax, 1; add eax, 1.
  const block = buildIrBlock(decodeBlock([0x83, 0xc0, 0x01, 0x83, 0xc0, 0x01]).instructions);
  const actions = entryActions(block);
  const flagWrites = actions.filter((action) =>
    isStateWrite(action) && x86Flags.some((flag) =>
      accessesChannel(block, action, flagStateFields.concrete[flag])
    )
  );
  const lazyKindWrites = actions.filter(
    (action) => isStateWrite(action) &&
      accessesChannel(block, action, flagStateFields.lazyKind)
  );

  strictEqual(flagWrites.length, 0);
  strictEqual(lazyKindWrites.length, 1);
  strictEqual(actions.filter((action) =>
    isStateWrite(action) && accessesChannel(block, action, coreStateFields.eip)
  ).length, 1);
  strictEqual(
    actions.filter((action) => action.kind === "finish" && action.finish.kind === "dispatch").length,
    1
  );
  const finishIndex = actions.findIndex(
    (action) => action.kind === "finish" && action.finish.kind === "dispatch"
  );
  const eipCommitIndex = actions.findIndex(
    (action) => isStateWrite(action) && accessesChannel(block, action, coreStateFields.eip)
  );

  ok(eipCommitIndex >= 0);
  ok(eipCommitIndex < finishIndex);
});

test("a guard fault mid-block reports the faulting eip with earlier state flushed", () => {
  // inc eax; mov eax, [0xff0000] — beyond the one-page guest memory.
  const faultAddress = 0xff_0000;
  const block = decodeBlock([0x40, 0x8b, 0x05, 0x00, 0x00, 0xff, 0x00]);
  const memories = createTestWasmMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  const stateView = new DataView(memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 5 });

  const run = handle.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, {
    kind: "cpuException",
    exception: pageFault(faultAddress, 0)
  });
  strictEqual(state.eax, 6);
  strictEqual(state.eip, startEip + 1);
  strictEqual(state.instructionCount, 1);
});

test("a segment-register load exits from a compiled block before committing the instruction", () => {
  // mov es, ax; inc eax. The decoder does not know the segment load ends
  // the flat32 IR block, so action compilation must stop after the first
  // instruction.
  const block = decodeBlock([0x8e, 0xc0, 0x40]);
  strictEqual(block.instructions.length, 2);
  const memories = createTestWasmMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  const stateView = new DataView(memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, {
    eip: startEip,
    eax: 0x1234_5678,
    esSelector: 0x1111,
    instructionCount: 7
  });

  const run = handle.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, {
    kind: "segmentLoad",
    segment: "es",
    selector: 0x5678
  });
  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.esSelector, 0x1111);
  strictEqual(state.eip, startEip);
  strictEqual(state.instructionCount, 7);
});

test("a compiled ENTER level 2 copies the display through semantic var loop cells", () => {
  const block = decodeBlock([0xc8, 0x04, 0x00, 0x02, 0xcd, 0x2e]);
  const memories = createTestWasmMemories();
  const guest = new DataView(memories.guestMemory.buffer);
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  guest.setUint32(0x17c, 0xaaaa_0001, true);
  writeWasmCpuStateSnapshot(stateView, {
    eip: startEip,
    esp: 0x120,
    ebp: 0x180,
    instructionCount: 7
  });

  const run = handle.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "hostTrap", vector: 0x2e });
  strictEqual(state.ebp, 0x11c);
  strictEqual(state.esp, 0x110);
  strictEqual(guest.getUint32(0x11c, true), 0x180);
  strictEqual(guest.getUint32(0x118, true), 0xaaaa_0001);
  strictEqual(guest.getUint32(0x114, true), 0x11c);
  strictEqual(state.eip, startEip + 6);
  strictEqual(state.instructionCount, 9);
});

test("a not-taken forward jcc keeps pre-branch register pendings live inside the block", () => {
  // mov eax, 7; cmp ecx, 0; je +2; add ebx, eax; int 0x2e.
  const block = decodeBlock([
    0xb8, 0x07, 0x00, 0x00, 0x00,
    0x83, 0xf9, 0x00,
    0x74, 0x02,
    0x01, 0xc3,
    0xcd, 0x2e
  ]);
  const ir = buildIrBlock(block.instructions);
  const actions = entryActions(ir);
  const branchIndex = actions.findIndex((action) => action.kind === "if");
  const ebxReadIndex = actions.findIndex(
    (action): action is Action =>
      isStateRead(action) && accessesChannel(ir, action, gprChannel("ebx"))
  );
  const ebxRead = actions[ebxReadIndex];
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  strictEqual(block.instructions.map((instruction) => instruction.spec.id).join(","), [
    "mov.r32_imm32",
    "cmp.rm32_imm8",
    "je.rel8",
    "add.rm32_r32",
    "int.imm8"
  ].join(","));
  strictEqual(branchIndex > 0, true);
  strictEqual(ebxReadIndex > branchIndex, true);
  strictEqual(
    actions.slice(branchIndex + 1, ebxReadIndex).some((action) => isStateWrite(action)),
    false
  );

  if (ebxRead === undefined || !isStateRead(ebxRead)) {
    throw new Error("expected ebx read after the branch");
  }

  const ebxWrite = actions.find((action) =>
    isStateWrite(action) && accessesChannel(ir, action, gprChannel("ebx"))
  );

  if (ebxWrite === undefined || !isStateWrite(ebxWrite)) {
    throw new Error("expected ebx write after the branch");
  }

  strictEqual(
    actions.filter((action) =>
      isStateWrite(action) && accessesChannel(ir, action, gprChannel("eax"))
    ).length,
    1
  );
  strictEqual(
    stateWriteValue(ebxWrite),
    ir.values.binary("add", ebxRead.output, ir.values.const(7))
  );

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, ebx: 0x20, ecx: 1 });

  const run = handle.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "hostTrap", vector: 0x2e });
  strictEqual(state.eax, 7);
  strictEqual(state.ebx, 0x27);
  strictEqual(state.eip, startEip + 14);
  strictEqual(state.instructionCount, 5);
});

test("a folded taken jecxz truncates the block and dispatches to its target", () => {
  // mov ecx, 0; jecxz +2; mov ebx, 7; int 0x2e — the pending ecx constant
  // folds the branch taken, so the block ends there and the tail never runs.
  const block = decodeBlock([
    0xb9, 0x00, 0x00, 0x00, 0x00,
    0xe3, 0x02,
    0xbb, 0x07, 0x00, 0x00, 0x00,
    0xcd, 0x2e
  ]);
  const targetEip = startEip + 9;

  strictEqual(block.instructions.length, 4);

  const ir = buildIrBlock(block.instructions);
  const actions = entryActions(ir);

  strictEqual(actions.some((action) => action.kind === "if"), false);
  strictEqual(actions.at(-1)?.kind, "finish");

  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, ebx: 0x20, ecx: 5 });

  const run = handle.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "linkStub", targetEip });
  strictEqual(state.ebx, 0x20);
  strictEqual(state.ecx, 0);
  strictEqual(state.eip, targetEip);
  strictEqual(state.instructionCount, 2);
});

test("a backward jcc to the block entry self-links as a return_call tail loop", () => {
  // sub ecx, 1; jnz start; int 0x2e.
  const block = decodeBlock([
    0x83, 0xe9, 0x01,
    0x75, 0xfb,
    0xcd, 0x2e
  ]);
  const ir = buildIrBlock(block.instructions);
  const bytes = encodeJitModule([{ entryEip: startEip, ir }]);
  const opcodes = wasmBodyOpcodes(extractOnlyWasmFunctionBody(bytes));
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  strictEqual(opcodes.includes(wasmOpcode.returnCall), true);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, ecx: 3 });

  const run = handle.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "hostTrap", vector: 0x2e });
  strictEqual(state.ecx, 0);
  strictEqual(state.eip, startEip + 7);
  strictEqual(state.instructionCount, 7);
});

test("into mid-block traps only on OF and otherwise falls through inside the block", () => {
  // mov eax, 1; into; mov ebx, 2; int 0x2e.
  const block = decodeBlock([
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0xce,
    0xbb, 0x02, 0x00, 0x00, 0x00,
    0xcd, 0x2e
  ]);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, OF: 0 });

  const clearRun = handle.run();
  const clearState = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(clearRun.exit, { kind: "hostTrap", vector: 0x2e });
  strictEqual(clearState.eax, 1);
  strictEqual(clearState.ebx, 2);
  strictEqual(clearState.eip, startEip + 13);
  strictEqual(clearState.instructionCount, 4);

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, ebx: 0x55, OF: 1 });

  const setRun = handle.run();
  const setState = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(setRun.exit, { kind: "hostTrap", vector: 4 });
  strictEqual(setState.eax, 1);
  strictEqual(setState.ebx, 0x55);
  strictEqual(setState.eip, startEip + 6);
  strictEqual(setState.instructionCount, 2);
});

test("a compiled MOV to CS raises invalid-opcode before segment-load handling", () => {
  // mov cs, ax.
  const block = decodeBlock([0x8e, 0xc8]);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, {
    eip: startEip,
    eax: 0x1234_5678,
    csSelector: 0x1111,
    instructionCount: 7
  });

  const run = handle.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "cpuException", exception: invalidOpcode() });
  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.csSelector, 0x1111);
  strictEqual(state.eip, startEip);
  strictEqual(state.instructionCount, 7);
});

test("a static jump to a block in the same module tail-calls it directly", () => {
  const targetEip = startEip + 0x10;
  // inc eax; jmp rel32 to targetEip.
  const first = decodeBlock([0x40, 0xe9, 0x0a, 0x00, 0x00, 0x00]);
  // inc eax; int 0x2e.
  const second = decodeBlock([0x40, 0xcd, 0x2e], targetEip);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = compileActionWasmBlockHandle([first, second], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 0 });

  const run = handle.run(startEip);
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "hostTrap", vector: 0x2e });
  strictEqual(state.eax, 2);
  strictEqual(state.eip, targetEip + 3);
  strictEqual(state.instructionCount, 4);
});

test("a dynamic jump returns the legacy transfer and resumes from flushed state", () => {
  // jmp eax.
  const block = decodeBlock([0xff, 0xe0]);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  writeWasmCpuStateSnapshot(stateView, { eip: startEip, eax: 0x4000 });

  const run = handle.run();
  const state = readWasmCpuStateSnapshot(stateView);

  deepStrictEqual(run.exit, { kind: "dynamicJump" });
  strictEqual(state.eip, 0x4000);
  strictEqual(state.instructionCount, 1);
});

function decodeBlock(bytes: readonly number[], eip = startEip): IsaDecodedBlock {
  return decodeIsaBlock(new ByteArrayDecodeReader(Uint8Array.from(bytes), eip), eip);
}

function entryActions(block: IrBlock): readonly Action[] {
  return block.body.actions;
}

function syntheticBlock(withResolver: boolean): IrBlock {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const stored = withResolver
    ? builder.call(cpuStatusFlagResolvers.get("ZF"), [])[0]!
    : values.const(7);
  const result = buildExit(values, trapExit(values.const(0)));

  builder.push(stateWrite(values, gprChannel("eax"), stored));
  builder.finish({ kind: "exit", result });
  return {
    body: builder.build(),
    values
  };
}

function syntheticDispatchBlock(targetEip: number): IrBlock {
  const values = new ValueTable();
  const target = values.const(targetEip);

  return {
    body: {
      actions: [
        stateWrite(values, coreStateFields.eip, target),
        {
          kind: "finish",
          finish: { kind: "dispatch", targetEip: target }
        }
      ]
    },
    values
  };
}

function accessesChannel(
  block: IrBlock,
  action: Extract<Action, { kind: "op" }>,
  channel: InstructionStateChannel
): boolean {
  const expected = stateEffect(block.values, channel);
  const actual = action.op.effects.reads[0] ?? action.op.effects.writes[0];

  return actual !== undefined &&
    covers(actual, expected) &&
    covers(expected, actual);
}
