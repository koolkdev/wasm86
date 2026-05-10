import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createCpuState } from "#x86/state/cpu-state.js";
import type { CpuState } from "#x86/state/cpu-state.js";
import type { RegisterAlias, Reg32 } from "#x86/isa/types.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#backends/wasm/encoder/module.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { wasmImport } from "#backends/wasm/abi.js";
import { readWasmCpuState, writeWasmCpuState } from "#backends/wasm/state-layout.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { jitInputReg32Value } from "#backends/wasm/jit/ir/values.js";
import { createJitIrState } from "#backends/wasm/jit/state/state.js";
import { createJitReg32State, type JitReg32State } from "#backends/wasm/jit/state/register-state.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import type { ValueWidth } from "#backends/wasm/codegen/value-width.js";
import {
  emitStoreStateU16,
  emitStoreStateU8
} from "#backends/wasm/codegen/state.js";
import {
  clearRegValueState,
  cloneRegValueState,
  emptyRegValueState,
  exactSourceForAlias,
  recordStableRegValue,
  type LocalRegValueSource,
  type Owner
} from "#backends/wasm/jit/state/register-values.js";
import { emitStoreRegState } from "#backends/wasm/jit/state/register-state-store.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { runJitIrBlock } from "./helpers.js";

const startAddress = 0x1000;
const al: RegisterAlias = { name: "al", base: "eax", bitOffset: 0, width: 8 };
const ah: RegisterAlias = { name: "ah", base: "eax", bitOffset: 8, width: 8 };
const bl: RegisterAlias = { name: "bl", base: "ebx", bitOffset: 0, width: 8 };
const ax: RegisterAlias = { name: "ax", base: "eax", bitOffset: 0, width: 16 };

function fullAlias(reg: Reg32): RegisterAlias {
  return { name: reg, base: reg, bitOffset: 0, width: 32 };
}

function emitWriteReg32(
  regs: JitReg32State,
  reg: Reg32,
  emitValue: () => ValueWidth | void
): void {
  regs.emitWriteAlias(fullAlias(reg), emitValue);
}

function emitCopyReg32(regs: JitReg32State, target: Reg32, source: Reg32): void {
  regs.emitWriteAlias(fullAlias(target), {
    emitValue: unexpectedFullCopyFallback,
    prefixSource: requiredFullPrefix(regs, source)
  });
}

test("jit register value state releases the old owner after overwrite", () => {
  const state = emptyRegValueState();
  const owner = trackedOwner();

  recordStableRegValue(state, 1, 32, owner);
  recordStableRegValue(state, 2, 8);

  strictEqual(owner.releaseCount(), 1);
});

test("jit register value state clone retains the owner", () => {
  const state = emptyRegValueState();
  const owner = trackedOwner();

  recordStableRegValue(state, 1, 32, owner);
  const clone = cloneRegValueState(state);

  clearRegValueState(state);
  strictEqual(owner.releaseCount(), 1);

  clearRegValueState(clone);
  strictEqual(owner.releaseCount(), 2);
});

test("jit register value state clearing releases the owner", () => {
  const state = emptyRegValueState();
  const owner = trackedOwner();

  recordStableRegValue(state, 1, 16, owner);
  clearRegValueState(state);

  strictEqual(owner.releaseCount(), 1);
});

test("jit register value state exact aliases use only low prefixes", () => {
  const state = emptyRegValueState();

  recordStableRegValue(state, 1, 8);
  strictEqual(exactSourceForAlias(state, al)?.local, 1);
  strictEqual(exactSourceForAlias(state, ax), undefined);
  strictEqual(exactSourceForAlias(state, fullAlias("eax")), undefined);
  strictEqual(exactSourceForAlias(state, ah), undefined);

  recordStableRegValue(state, 2, 16);
  strictEqual(exactSourceForAlias(state, al)?.local, 2);
  strictEqual(exactSourceForAlias(state, ax)?.local, 2);
  strictEqual(exactSourceForAlias(state, fullAlias("eax")), undefined);
  strictEqual(exactSourceForAlias(state, ah), undefined);

  recordStableRegValue(state, 3, 32);
  strictEqual(exactSourceForAlias(state, al)?.local, 3);
  strictEqual(exactSourceForAlias(state, ax)?.local, 3);
  strictEqual(exactSourceForAlias(state, fullAlias("eax"))?.local, 3);
  strictEqual(exactSourceForAlias(state, ah), undefined);
});

test("jit register state transfers pending prefix owners when committing", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);
  const local = body.addLocal(wasmValueType.i32);
  const owner = trackedOwner();

  regs.beginInstruction({ preserveCommittedRegs: true });
  regs.emitWriteAlias(fullAlias("eax"), {
    emitValue: unexpectedFullCopyFallback,
    prefixSource: fullPrefix(local, owner)
  });
  regs.commitPending();

  strictEqual(owner.releaseCount(), 0);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(1);
  });
  body.end();

  strictEqual(owner.releaseCount(), 1);
});

test("jit register state writes register-only instructions to committed locals", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(1);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(2);
  });
  regs.commitPending();
  body.end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.localSet), 2);
});

test("jit register state stages writes when pre-instruction exits need committed locals", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(1);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: true });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(2);
  });
  regs.commitPending();
  body.end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.localSet), 2);
});

test("jit register state returns to committed writes after pre-instruction exits", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: true });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(1);
  });
  regs.commitPending();
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(2);
  });
  regs.commitPending();
  body.end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.localSet), 2);
});

test("jit register state exposes prefixes only when the alias is covered", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0x44);
  });
  regs.commitPending();

  strictEqual(regs.knownPrefixForAlias(al)?.width, 8);
  strictEqual(regs.knownPrefixForAlias(ax), undefined);
  strictEqual(regs.knownPrefixForAlias(fullAlias("eax")), undefined);
});

test("jit register state copies full-register prefix values without value emission", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1122_3344);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitCopyReg32(regs, "ebx", "eax");
  regs.commitPending();
  body.end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.localSet), 1);
});

test("jit register state keeps copied prefix values stable after later source full writes", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1111_1111);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitCopyReg32(regs, "ebx", "eax");
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x2222_2222);
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  regs.emitCommittedStore("ebx");
  body.end();

  const state = await runRegisterStateBody(body);

  strictEqual(state.eax, 0x2222_2222);
  strictEqual(state.ebx, 0x1111_1111);
});

test("jit register state freezes pending full-register values before pending full copies", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1111_1111);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: true });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x2222_2222);
  });
  emitCopyReg32(regs, "ebx", "eax");
  regs.commitPending();
  regs.emitCommittedStore("eax");
  regs.emitCommittedStore("ebx");
  body.end();

  const state = await runRegisterStateBody(body);

  strictEqual(state.eax, 0x2222_2222);
  strictEqual(state.ebx, 0x2222_2222);
});

test("jit register state freezes pending mutable copies without changing committed source", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1111_1111);
  });
  regs.commitPending();

  regs.beginInstruction({ preserveCommittedRegs: true });
  regs.emitWriteAlias(ah, () => {
    body.i32Const(0x22);
  });
  emitCopyReg32(regs, "ebx", "eax");
  // Simulates a pre-instruction exit store before pending writes are committed.
  regs.emitCommittedStore("eax");
  regs.commitPending();
  regs.emitCommittedStore("ebx");
  body.end();

  const state = await runRegisterStateBody(body);

  strictEqual(state.eax, 0x1111_1111);
  strictEqual(state.ebx, 0x1111_2211);
});

test("jit register state full writes can read the previous mutable value", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1111_1111);
  });
  regs.commitPending();

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(ah, () => {
    body.i32Const(0x22);
  });
  regs.commitPending();

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x2222_2222);
    regs.emitReadReg32("eax");
    body.i32Const(0);
    body.select();
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  body.end();

  const state = await runRegisterStateBody(body);

  strictEqual(state.eax, 0x1111_2211);
});

test("jit register state keeps copied prefix values stable after later destination partial writes", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1122_3344);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitCopyReg32(regs, "ebx", "eax");
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(bl, () => {
    body.i32Const(0xaa);
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  regs.emitCommittedStore("ebx");
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());
  const state = await runRegisterStateBody(body);

  strictEqual(countOpcode(opcodes, wasmOpcode.localSet), 3);
  strictEqual(state.eax, 0x1122_3344);
  strictEqual(state.ebx, 0x1122_33aa);
});

test("jit register state keeps copied prefix values stable after later source partial writes", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1122_3344);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitCopyReg32(regs, "ebx", "eax");
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0xaa);
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  regs.emitCommittedStore("ebx");
  body.end();

  const state = await runRegisterStateBody(body);

  strictEqual(state.eax, 0x1122_33aa);
  strictEqual(state.ebx, 0x1122_3344);
});

test("jit register state copied prefix values preserve committed locals while writes are pending", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1111_1111);
  });
  emitWriteReg32(regs, "ebx", () => {
    body.i32Const(0x2222_2222);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: true });
  emitCopyReg32(regs, "eax", "ebx");
  regs.emitCommittedStore("eax");
  regs.commitPending();
  body.end();

  const state = await runRegisterStateBody(body);

  strictEqual(state.eax, 0x1111_1111);
});

test("jit register state feeds later instructions from committed register values", async () => {
  const result = await runJitIrBlock(
    [
      0xb8, 0x23, 0x01, 0x00, 0x00, // mov eax, 0x123
      0x89, 0xc3, // mov ebx, eax
      0x83, 0xc3, 0x01, // add ebx, 1
      0xcd, 0x2e // int 0x2e
    ],
    createCpuState({
      eax: 0xffff_ffff,
      ebx: 0xeeee_eeee,
      eip: startAddress,
      instructionCount: 20
    })
  );

  strictEqual(result.state.eax, 0x123);
  strictEqual(result.state.ebx, 0x124);
  strictEqual(result.state.instructionCount, 24);
  strictEqual(result.state.eip, startAddress + 12);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit register state reads known partial prefixes without loading the full register", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0x44);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitReadAlias(al);
  regs.commitPending();
  body.end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Load), 0);
});

test("jit register state reads back high-byte fallback writes", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(ah, () => {
    body.i32Const(0xaa);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "ebx", () => regs.emitReadAlias(ah));
  regs.commitPending();
  regs.emitCommittedStore("eax");
  regs.emitCommittedStore("ebx");
  body.end();

  const state = await runRegisterStateBody(body, createCpuState({ eax: 0x1122_3344 }));

  strictEqual(state.eax, 0x1122_aa44);
  strictEqual(state.ebx, 0xaa);
});

test("jit register state masks low aliases read from full local-backed values", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x1122_3344);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "ebx", () => regs.emitReadAlias(al));
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "ecx", () => regs.emitReadAlias(ax));
  regs.commitPending();
  regs.emitCommittedStore("eax");
  regs.emitCommittedStore("ebx");
  regs.emitCommittedStore("ecx");
  body.end();

  const state = await runRegisterStateBody(body);

  strictEqual(state.eax, 0x1122_3344);
  strictEqual(state.ebx, 0x44);
  strictEqual(state.ecx, 0x3344);
});

test("jit register state materializes full registers when a wider read needs unknown bits", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0x44);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitReadAlias(ax);
  regs.commitPending();
  body.end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Load), 1);
});

test("jit register state materializes full registers after partial writes when full reads need unknown bits", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0x44);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitReadReg32("eax");
  regs.commitPending();
  body.end();

  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Load), 1);
});

test("jit register state full reads merge partial writes with unknown bits", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0xaa);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(ah, () => {
    body.i32Const(0xbb);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "ebx", () => regs.emitReadReg32("eax"));
  regs.commitPending();
  regs.emitCommittedStore("eax");
  regs.emitCommittedStore("ebx");
  body.end();

  const state = await runRegisterStateBody(body, createCpuState({ eax: 0x1122_3344 }));

  strictEqual(state.eax, 0x1122_bbaa);
  strictEqual(state.ebx, 0x1122_bbaa);
});

test("jit register exit stores use byte stores for low-byte prefixes", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0x05);
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Load), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store16), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 1);
});

test("jit register exit stores use word stores for low-word prefixes", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(ax, () => {
    body.i32Const(0x12345);
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Load), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store16), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 0);
});

test("jit register exit stores keep composed ax/al writes as a word prefix", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(ax, () => {
    body.i32Const(0x1234);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0x56);
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Load), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store16), 1);
});

test("jit register high-byte writes use the mutable full-register fallback", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(ax, () => {
    body.i32Const(0x1234);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(ah, () => {
    body.i32Const(0x56);
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  body.end();

  const state = await runRegisterStateBody(body, createCpuState({ eax: 0xabcd_0000 }));

  strictEqual(state.eax, 0xabcd_5634);
});

test("jit register exit store skips unknown state", () => {
  const body = new WasmFunctionBodyEncoder();

  emitStoreRegState(body, "eax", emptyRegValueState());
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store16), 0);
});

test("jit register direct store helpers emit narrow stores", () => {
  const body = new WasmFunctionBodyEncoder();

  emitStoreStateU8(body, 0, () => {
    body.localGet(0);
  });
  emitStoreStateU16(body, 0, () => {
    body.localGet(0);
  });
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store16), 1);
});

test("jit register state keeps low-byte alu updates narrow", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0x05);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    regs.emitReadAlias(al);
    regs.emitReadAlias(bl);
    body.i32Xor();
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Load), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Load8U), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store16), 0);
});

test("jit register state stores full registers after a partial write is materialized by a full read", () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  regs.emitWriteAlias(al, () => {
    body.i32Const(0x05);
  });
  regs.commitPending();
  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "ebx", () => {
    regs.emitReadReg32("eax");
  });
  regs.commitPending();
  regs.emitCommittedStore("eax");
  regs.emitCommittedStore("ebx");
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Load), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store), 2);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store8), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Store16), 0);
});

test("jit exit materializations require captured register state", () => {
  const body = new WasmFunctionBodyEncoder();
  const state = createJitIrState(body, [
    { stores: [], flagMask: 0 },
    {
      stores: [{
        target: { kind: "reg32", reg: "eax" },
        value: jitInputReg32Value("eax")
      }],
      flagMask: 0
    }
  ]);

  state.emitExitMaterializationStores(0);
  throws(
    () => state.emitExitMaterializationStores(1),
    /JIT exit materialization was not captured: 1/
  );
});

test("jit exit materializations store planned sources to CPU state", async () => {
  const body = new WasmFunctionBodyEncoder();
  const exitLocal = body.addLocal(wasmValueType.i64);
  const state = createJitIrState(body, [
    { stores: [], flagMask: 0 },
    {
      stores: [{
        target: { kind: "reg32", reg: "ebx" },
        value: jitInputReg32Value("eax")
      }],
      flagMask: 0
    }
  ]);

  state.beginInstruction(
    { exitLocal, exitLabelDepth: 0 },
    {
      instructionIndex: 0,
      snapshot: {
        kind: "preInstruction",
        eip: startAddress,
        instructionCountDelta: 0,
        valueState: createJitValueState().snapshot(),
        committedFlags: { mask: 0 },
        speculativeFlags: { mask: 0 }
      }
    }
  );
  emitWriteReg32(state.regs, "ebx", () => {
    body.i32Const(0x2222_2222);
  });
  state.commitInstructionExit({
    instructionIndex: 0,
    opIndex: 0,
    exitReason: ExitReason.FALLTHROUGH,
    snapshot: {
      kind: "postInstruction",
      eip: startAddress + 1,
      instructionCountDelta: 1,
      valueState: createJitValueState().snapshot(),
      committedFlags: { mask: 0 },
      speculativeFlags: { mask: 0 }
    },
    exitMaterializationIndex: 1
  }, () => {
    body.i32Const(startAddress + 1);
  });
  state.emitExitMaterializationStores(1);
  body.end();

  const result = await runRegisterStateBody(body, createCpuState({
    eax: 0x1111_1111,
    ebx: 0x3333_3333
  }));

  strictEqual(result.eax, 0x1111_1111);
  strictEqual(result.ebx, 0x1111_1111);
});

test("jit register exit snapshot stores read source register state", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x2222_2222);
  });
  regs.commitPending();
  const snapshot = regs.captureCommittedExitStores(["eax"]);

  regs.emitExitSnapshotStore("ebx", snapshot, "eax");
  body.end();

  const state = await runRegisterStateBody(body, createCpuState({ ebx: 0x1111_1111 }));

  strictEqual(state.ebx, 0x2222_2222);
});

test("jit register exit store snapshots freeze committed writes before later mutation", async () => {
  const body = new WasmFunctionBodyEncoder();
  const regs = createJitReg32State(body);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x2222_2222);
  });
  regs.commitPending();
  const snapshot = regs.captureCommittedExitStores(["eax"]);

  regs.beginInstruction({ preserveCommittedRegs: false });
  emitWriteReg32(regs, "eax", () => {
    body.i32Const(0x3333_3333);
  });
  regs.commitPending();
  regs.emitExitSnapshotStore("eax", snapshot);
  body.end();

  const state = await runRegisterStateBody(body, createCpuState({ eax: 0x1111_1111 }));

  strictEqual(state.eax, 0x2222_2222);
});

test("jit register exit store snapshots store committed registers on a later memory fault", async () => {
  const result = await runJitIrBlock(
    [
      0xb8, 0x11, 0x11, 0x11, 0x11, // mov eax, 0x11111111
      0xbb, 0x22, 0x22, 0x22, 0x22, // mov ebx, 0x22222222
      0x89, 0x05, 0x00, 0x00, 0x01, 0x00, // mov [0x10000], eax
      0xb9, 0x33, 0x33, 0x33, 0x33 // mov ecx, 0x33333333
    ],
    createCpuState({
      eax: 0xaaaa_aaaa,
      ebx: 0xbbbb_bbbb,
      ecx: 0xcccc_cccc,
      eflags: 0xabcd_0000,
      eip: startAddress,
      instructionCount: 40
    })
  );

  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_WRITE_FAULT, payload: 0x10000, detail: 4 });
  strictEqual(result.state.eax, 0x1111_1111);
  strictEqual(result.state.ebx, 0x2222_2222);
  strictEqual(result.state.ecx, 0xcccc_cccc);
  strictEqual(result.state.eflags, 0xabcd_0000);
  strictEqual(result.state.eip, startAddress + 10);
  strictEqual(result.state.instructionCount, 42);
});

test("jit register pre-instruction exits store committed high-byte fallback writes", async () => {
  const result = await runJitIrBlock(
    [
      0xb4, 0x55, // mov ah, 0x55
      0x89, 0x05, 0x00, 0x00, 0x01, 0x00 // mov [0x10000], eax
    ],
    createCpuState({
      eax: 0x1122_3344,
      eip: startAddress,
      instructionCount: 10
    })
  );

  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_WRITE_FAULT, payload: 0x10000, detail: 4 });
  strictEqual(result.state.eax, 0x1122_5544);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 11);
});

function requiredFullPrefix(regs: JitReg32State, reg: Reg32): LocalRegValueSource {
  return regs.ensureStableFullValueForCopy(reg);
}

function fullPrefix(local: number, owner?: Owner | undefined): LocalRegValueSource {
  return owner === undefined
    ? { kind: "local", local, width: 32 }
    : { kind: "local", local, width: 32, owner };
}

function trackedOwner(): Owner & Readonly<{
  releaseCount(): number;
}> {
  const counter = { releases: 0 };

  return createTrackedOwner(counter);
}

function createTrackedOwner(counter: { releases: number }): Owner & Readonly<{
  releaseCount(): number;
}> {
  let released = false;

  return {
    retain: () => createTrackedOwner(counter),
    release: () => {
      if (released) {
        throw new Error("tracked owner released twice");
      }

      released = true;
      counter.releases += 1;
    },
    releaseCount: () => counter.releases
  };
}

function unexpectedFullCopyFallback(): never {
  throw new Error("known full-register copies should not emit their fallback value");
}

async function runRegisterStateBody(
  body: WasmFunctionBodyEncoder,
  initialState: CpuState = createCpuState()
): Promise<CpuState> {
  const module = new WasmModuleEncoder();
  const memoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, { minPages: 1 });

  strictEqual(memoryIndex, 0);

  const typeIndex = module.addFunctionType({ params: [], results: [] });
  const functionIndex = module.addFunction(typeIndex, body);

  module.exportFunction("run", functionIndex);

  const stateMemory = new WebAssembly.Memory({ initial: 1 });
  const stateView = new DataView(stateMemory.buffer);

  writeWasmCpuState(stateView, initialState);

  const instance = await WebAssembly.instantiate(new WebAssembly.Module(module.encode()), {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: stateMemory
    }
  });
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported register-state test function");
  }

  run();

  return readWasmCpuState(stateView);
}

function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodes.filter((entry) => entry === opcode).length;
}
