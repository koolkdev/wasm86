import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { buildIrBlock } from "#engines/jit/action-compiler.js";
import { encodeJitModule } from "#engines/jit/module.js";
import { compileActionWasmBlockHandle } from "#engines/jit/block-handle.js";
import type { Action } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable } from "#ir/value-table.js";
import { fitsUnsigned } from "#ir/values.js";
import { gprChannel, lazyFlagsKindChannel, type StateSlot } from "#ir/slots.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { ByteArrayDecodeReader } from "#core/decoder/tests/helpers.js";
import { decodeIsaBlock, type IsaDecodedBlock } from "#core/decoder/decode-block.js";
import { CompletionExit, HostExit } from "#wasm/exit.js";
import { invalidOpcode } from "#core/exceptions.js";
import { readPageFaultExit } from "#wasm/tests/exit-fixtures.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { readWasmCpuState } from "#test/support/cpu-state.js";
import {
  extractOnlyWasmFunctionBody,
  wasmBodyOpcodes,
  wasmDefinedFunctionCount
} from "#compiler/encoder/tests/body-opcodes.js";
import { isStateRead, isStateWrite, resolveFlag, stateWrite } from "#ir/tests/storage-op-helpers.js";

const startEip = 0x1000;

test("JIT module emits no helper functions for ordinary blocks", () => {
  const bytes = encodeJitModule([{ entryEip: startEip, ir: syntheticBlock(false) }]);

  strictEqual(wasmDefinedFunctionCount(bytes), 1);
});

test("JIT module emits a referenced lazy flag helper", () => {
  const bytes = encodeJitModule([{ entryEip: startEip, ir: syntheticBlock(true) }]);

  strictEqual(wasmDefinedFunctionCount(bytes), 2);
});

test("JIT module includes helpers introduced by input flag reads", () => {
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

  strictEqual(actions.filter((action) => isStateRead(action) && isEaxWordSlot(action.op.slot)).length, 1);
  strictEqual(actions.filter((action) => isStateWrite(action) && isEaxWordSlot(action.op.slot)).length, 1);
});

test("cross-instruction dead flag writes are absent and dispatch owns EIP state", () => {
  // add eax, 1; add eax, 1.
  const block = buildIrBlock(decodeBlock([0x83, 0xc0, 0x01, 0x83, 0xc0, 0x01]).instructions);
  const actions = entryActions(block);
  const flagWrites = actions.flatMap((action) =>
    isStateWrite(action) && action.op.slot.kind === "flag" ? [action.op.slot.flag] : []
  );
  const lazyKindWrites = actions.filter(
    (action) => isStateWrite(action) && action.op.slot === lazyFlagsKindChannel
  );

  strictEqual(flagWrites.length, 0);
  strictEqual(new Set(flagWrites).size, flagWrites.length);
  strictEqual(lazyKindWrites.length, 1);
  strictEqual(actions.filter((action) => isStateWrite(action) && action.op.slot.kind === "eip").length, 0);
  strictEqual(
    actions.filter((action) => action.kind === "finish" && action.finish.kind === "dispatch").length,
    1
  );
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

  deepStrictEqual(run.exit, readPageFaultExit(faultAddress));
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
  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  memories.cpuState.load({
    eip: startEip,
    eax: 0x1234_5678,
    esSelector: 0x1111,
    instructionCount: 7
  });

  const run = handle.run();
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { family: "host", reason: HostExit.SEGMENT_LOAD, payload: 0x5678 });
  strictEqual(state.eax, 0x1234_5678);
  strictEqual(state.esSelector, 0x1111);
  strictEqual(state.eip, startEip);
  strictEqual(state.instructionCount, 7);
});

test("a compiled ENTER level 2 copies the display through semantic var loop cells", () => {
  const block = decodeBlock([0xc8, 0x04, 0x00, 0x02, 0xcd, 0x2e]);
  const memories = createWasmHostMemories();
  const guest = new DataView(memories.guestMemory.buffer);
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  guest.setUint32(0x17c, 0xaaaa_0001, true);
  memories.cpuState.load({
    eip: startEip,
    esp: 0x120,
    ebp: 0x180,
    instructionCount: 7
  });

  const run = handle.run();
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { family: "host", reason: HostExit.TRAP, payload: 0x2e });
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
      isStateRead(action) && action.op.slot === gprChannel("ebx")
  );
  const ebxRead = actions[ebxReadIndex];
  const memories = createWasmHostMemories();
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
  strictEqual(handle.moduleLinkTable?.table.length, 1);
  strictEqual(branchIndex > 0, true);
  strictEqual(ebxReadIndex > branchIndex, true);
  strictEqual(
    actions.slice(branchIndex + 1, ebxReadIndex).some((action) => isStateWrite(action)),
    false
  );

  if (ebxRead === undefined || !isStateRead(ebxRead)) {
    throw new Error("expected ebx read after the branch");
  }

  const ebxWrite = actions.find((action) => isStateWrite(action) && action.op.slot === gprChannel("ebx"));

  if (ebxWrite === undefined || !isStateWrite(ebxWrite)) {
    throw new Error("expected ebx write after the branch");
  }

  strictEqual(
    actions.filter((action) => isStateWrite(action) && action.op.slot === gprChannel("eax")).length,
    1
  );
  strictEqual(
    ebxWrite.op.value,
    ir.values.binary("add", ebxRead.output, ir.values.const(7))
  );

  memories.cpuState.load({ eip: startEip, ebx: 0x20, ecx: 1 });

  const run = handle.run();
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { family: "host", reason: HostExit.TRAP, payload: 0x2e });
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

  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  memories.cpuState.load({ eip: startEip, ebx: 0x20, ecx: 5 });

  const run = handle.run();
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { family: "completion", reason: CompletionExit.LINK_STUB, payload: targetEip });
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
  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  strictEqual(handle.moduleLinkTable, undefined);
  strictEqual(opcodes.includes(wasmOpcode.returnCall), true);

  memories.cpuState.load({ eip: startEip, ecx: 3 });

  const run = handle.run();
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { family: "host", reason: HostExit.TRAP, payload: 0x2e });
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
  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  memories.cpuState.load({ eip: startEip, OF: 0 });

  const clearRun = handle.run();
  const clearState = readWasmCpuState(memories.cpuState);

  deepStrictEqual(clearRun.exit, { family: "host", reason: HostExit.TRAP, payload: 0x2e });
  strictEqual(clearState.eax, 1);
  strictEqual(clearState.ebx, 2);
  strictEqual(clearState.eip, startEip + 13);
  strictEqual(clearState.instructionCount, 4);

  memories.cpuState.load({ eip: startEip, ebx: 0x55, OF: 1 });

  const setRun = handle.run();
  const setState = readWasmCpuState(memories.cpuState);

  deepStrictEqual(setRun.exit, { family: "host", reason: HostExit.TRAP, payload: 4 });
  strictEqual(setState.eax, 1);
  strictEqual(setState.ebx, 0x55);
  strictEqual(setState.eip, startEip + 6);
  strictEqual(setState.instructionCount, 2);
});

test("a compiled MOV to CS raises invalid-opcode before segment-load handling", () => {
  // mov cs, ax.
  const block = decodeBlock([0x8e, 0xc8]);
  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  memories.cpuState.load({
    eip: startEip,
    eax: 0x1234_5678,
    csSelector: 0x1111,
    instructionCount: 7
  });

  const run = handle.run();
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { family: "cpuException", exception: invalidOpcode() });
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
  const memories = createWasmHostMemories();
  const handle = compileActionWasmBlockHandle([first, second], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });

  strictEqual(handle.moduleLinkTable, undefined);

  memories.cpuState.load({ eip: startEip, eax: 0 });

  const run = handle.run(startEip);
  const state = readWasmCpuState(memories.cpuState);

  deepStrictEqual(run.exit, { family: "host", reason: HostExit.TRAP, payload: 0x2e });
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

  deepStrictEqual(run.exit, { family: "completion", reason: CompletionExit.DYNAMIC_JUMP, payload: 0 });
  strictEqual(state.eip, 0x4000);
  strictEqual(state.instructionCount, 1);
});

function decodeBlock(bytes: readonly number[], eip = startEip): IsaDecodedBlock {
  return decodeIsaBlock(new ByteArrayDecodeReader(Uint8Array.from(bytes), eip), eip);
}

function entryActions(block: IrBlock): readonly Action[] {
  return block.body.actions;
}

function isEaxWordSlot(slot: StateSlot): boolean {
  return slot.kind === "gpr" && slot.reg === "eax" && slot.byteOffsetInReg === 0 && slot.byteLength === 4;
}

function syntheticBlock(withHelper: boolean): IrBlock {
  const values = new ValueTable();
  const stored = withHelper ? values.addActionOutput(fitsUnsigned(1)) : values.const(7);

  return {
    body: {
      actions: [
        ...(withHelper ? [resolveFlag(stored, "ZF")] : []),
        stateWrite(gprChannel("eax"), stored),
        { kind: "finish", finish: { kind: "exit", exit: { class: "host", reason: "hostTrap" } } }
      ]
    },
    values
  };
}

function syntheticDispatchBlock(targetEip: number): IrBlock {
  const values = new ValueTable();

  return {
    body: {
      actions: [{
        kind: "finish",
        finish: { kind: "dispatch", targetEip: values.const(targetEip) }
      }]
    },
    values
  };
}
