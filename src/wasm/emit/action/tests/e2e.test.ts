import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createActionBuilder, type ActionBuilder } from "#ir/action/builder.js";
import { immBinding, regBinding } from "#ir/action/operands.js";
import { eipChannel, gprChannel } from "#ir/action/slots.js";
import type { SemanticTemplate } from "#ir/model/types.js";
import type { RegName } from "#x86/types.js";
import { movSemantic } from "#x86/semantics/mov.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import { emitActionBlock } from "#wasm/emit/action/emit.js";
import { decodeExit, ExitReason } from "#wasm/exit.js";
import { readWasmStateChannel, writeWasmCpuState } from "#wasm/state-layout.js";
import { wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import { instantiateActionBlock } from "./harness.js";

// The stage's end-to-end slice: semantics -> ActionBuilder -> emit ->
// instantiate -> run -> assert state memory through the host view.

function readRegister(view: DataView, name: RegName): number {
  return readWasmStateChannel(view, gprChannel(name));
}

function assertFallthrough(exit: bigint): void {
  deepStrictEqual(decodeExit(exit), { exitReason: ExitReason.FALLTHROUGH, payload: 0 });
}

test("mov r32, imm32 sets the register bytes and eip and falls through", async () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], {
    eip: 0x401000,
    nextEip: 0x401005
  });

  const { stateView, run } = await instantiateActionBlock(builder.finish());

  assertFallthrough(run());
  strictEqual(readRegister(stateView, "eax"), 0x12345678);
  strictEqual(readWasmStateChannel(stateView, eipChannel), 0x401005);
});

test("mov r32, r32 copies the source register and leaves it intact", async () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const { stateView, run } = await instantiateActionBlock(builder.finish());

  writeWasmCpuState(stateView, { eax: 0xcafe1234 });
  assertFallthrough(run());
  strictEqual(readRegister(stateView, "eax"), 0xcafe1234);
  strictEqual(readRegister(stateView, "ebx"), 0xcafe1234);
  strictEqual(readWasmStateChannel(stateView, eipChannel), 0x1002);
});

test("chained movs forward one read to both destinations", async () => {
  const builder = createActionBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("ebx"), regBinding("eax")], { eip: 0x1000, nextEip: 0x1002 });
  builder.addInstruction(mov, [regBinding("ecx"), regBinding("ebx")], { eip: 0x1002, nextEip: 0x1004 });

  const block = builder.finish();

  // The second mov forwards the first read instead of reading ebx.
  strictEqual(block.regions[0]!.actions.filter((action) => action.kind === "readState").length, 1);

  const { stateView, run } = await instantiateActionBlock(block);

  writeWasmCpuState(stateView, { eax: 0xdeadbeef });
  assertFallthrough(run());
  strictEqual(readRegister(stateView, "ebx"), 0xdeadbeef);
  strictEqual(readRegister(stateView, "ecx"), 0xdeadbeef);
  strictEqual(readWasmStateChannel(stateView, eipChannel), 0x1004);
});

test("xchg eax, ebx swaps the registers", async () => {
  const builder = createActionBuilder();

  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const { stateView, run } = await instantiateActionBlock(builder.finish());

  writeWasmCpuState(stateView, { eax: 0x11111111, ebx: 0x22222222 });
  assertFallthrough(run());
  // The pinning rule is load-bearing here: reloading ebx at its use would
  // observe the just-stored eax and leave both registers equal.
  strictEqual(readRegister(stateView, "eax"), 0x22222222);
  strictEqual(readRegister(stateView, "ebx"), 0x11111111);
});

test("a mov before the xchg observes the pre-swap value", async () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ecx"), regBinding("eax")], {
    eip: 0x1000,
    nextEip: 0x1002
  });
  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], {
    eip: 0x1002,
    nextEip: 0x1004
  });

  const { stateView, run } = await instantiateActionBlock(builder.finish());

  writeWasmCpuState(stateView, { eax: 0x11111111, ebx: 0x22222222 });
  assertFallthrough(run());
  strictEqual(readRegister(stateView, "ecx"), 0x11111111);
  strictEqual(readRegister(stateView, "eax"), 0x22222222);
  strictEqual(readRegister(stateView, "ebx"), 0x11111111);
});

test("a value used twice computes once and both uses observe it", async () => {
  // eax = ebx = eax + ebx: one interned add consumed by both stores.
  const sumIntoBoth: SemanticTemplate = (s) => {
    const sum = s.i32Add(s.get(s.operand(0), 32), s.get(s.operand(1), 32));

    s.set(s.operand(0), sum, 32);
    s.set(s.operand(1), sum, 32);
  };
  const builder: ActionBuilder = createActionBuilder();

  builder.addInstruction(sumIntoBoth, [regBinding("eax"), regBinding("ebx")], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();
  const body = emitActionBlock(block, { body: new WasmFunctionBodyEncoder() }).encode();

  strictEqual(wasmBodyOpcodes(body).filter((opcode) => opcode === wasmOpcode.i32Add).length, 1);

  const { stateView, run } = await instantiateActionBlock(block);

  writeWasmCpuState(stateView, { eax: 100, ebx: 28 });
  assertFallthrough(run());
  strictEqual(readRegister(stateView, "eax"), 128);
  strictEqual(readRegister(stateView, "ebx"), 128);
});
