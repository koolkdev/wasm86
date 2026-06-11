import { ok as assertOk, strictEqual } from "node:assert";
import { test } from "node:test";

import { executeDirectInstruction } from "#backends/direct/execute.js";
import { createActionBuilder } from "#ir/action/builder.js";
import { regBinding, type OperandBinding } from "#ir/action/operands.js";
import { eipChannel, gprChannel } from "#ir/action/slots.js";
import type { WriteStateAction } from "#ir/action/types.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { StopReason } from "#x86/execution/run-result.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { createCpuState, getFlag, type CpuState } from "#x86/state/cpu-state.js";
import { reg32 } from "#x86/types.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import { emitActionBlock } from "#wasm/emit/action/emit.js";
import { decodeExit, ExitReason } from "#wasm/exit.js";
import { readWasmFlagByte, readWasmStateChannel, writeWasmCpuState } from "#wasm/state-layout.js";
import { wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";
import { instantiateActionBlock } from "./harness.js";

// Stage 3's end-to-end slice: ALU r32 forms through the action pipeline with
// every flag byte checked against the direct backend executing the same
// decoded instruction on a CpuState. The decoded spec supplies the semantic
// template to both sides, so the comparison is between the two executions,
// never between two transcriptions of the instruction.

// All six arithmetic flags set, so every clear is observable.
const allArithmeticEflags = 0x8d5;

// dst=ebx, src=ecx for every form: modrm 0xcb = mod 11, reg ecx, rm ebx.
const aluCases: readonly Readonly<{
  name: string;
  bytes: readonly number[];
}>[] = [
  { name: "add ebx, ecx", bytes: [0x01, 0xcb] },
  { name: "or ebx, ecx", bytes: [0x09, 0xcb] },
  { name: "and ebx, ecx", bytes: [0x21, 0xcb] },
  { name: "sub ebx, ecx", bytes: [0x29, 0xcb] },
  { name: "xor ebx, ecx", bytes: [0x31, 0xcb] },
  { name: "cmp ebx, ecx", bytes: [0x39, 0xcb] },
  { name: "test ebx, ecx", bytes: [0x85, 0xcb] }
];

// Edge values per pair position: zero results, carries, signed overflow in
// both directions, aux carry, and mixed bits for parity.
const operandPairs: readonly Readonly<{ left: number; right: number }>[] = [
  { left: 0x0000_0000, right: 0x0000_0000 },
  { left: 0xffff_ffff, right: 0x0000_0001 },
  { left: 0x7fff_ffff, right: 0x0000_0001 },
  { left: 0x8000_0000, right: 0x0000_0001 },
  { left: 0x8000_0000, right: 0x8000_0000 },
  { left: 0x0000_0001, right: 0x0000_0002 },
  { left: 0x0000_000f, right: 0x0000_0001 },
  { left: 0x1234_5678, right: 0x9abc_def0 }
];

for (const aluCase of aluCases) {
  test(`${aluCase.name} matches the direct reference across edge values`, async () => {
    for (const pair of operandPairs) {
      const label = `${aluCase.name} with ${hex(pair.left)}, ${hex(pair.right)}`;
      const instruction = ok(decodeBytes(aluCase.bytes));
      const initial: Partial<CpuState> = {
        ebx: pair.left,
        ecx: pair.right,
        eip: instruction.address,
        eflags: allArithmeticEflags
      };
      const refState = createCpuState(initial);
      const result = executeDirectInstruction(refState, instruction);

      strictEqual(result.stopReason, StopReason.NONE, label);

      const builder = createActionBuilder();

      builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), {
        eip: instruction.address,
        nextEip: instruction.nextEip
      });

      const { stateView, run } = await instantiateActionBlock(builder.finish());

      writeWasmCpuState(stateView, initial);
      strictEqual(decodeExit(run()).exitReason, ExitReason.FALLTHROUGH, label);
      assertMatchesReference(stateView, refState, label);
    }
  });
}

test("two adds in one block store each flag byte once, with the second add's flags", async () => {
  // 0x7fff_fffe + 1 + 1: the adds disagree on SF/OF/AF/PF, so the collapsed
  // stores observably carry the second instruction's values.
  const first = ok(decodeBytes([0x01, 0xcb]));
  const second = ok(decodeBytes([0x01, 0xcb], first.nextEip));
  const builder = createActionBuilder();

  builder.addInstruction(first.spec.semantics, bindingsFor(first), {
    eip: first.address,
    nextEip: first.nextEip
  });
  builder.addInstruction(second.spec.semantics, bindingsFor(second), {
    eip: second.address,
    nextEip: second.nextEip
  });

  const block = builder.finish();

  // Dead flag writes collapse in the contract: one writeState per flag...
  const entry = block.regions[0]!;

  assertOk(entry.kind === "entry", "first region is the entry");

  const flagWrites = entry.actions.filter(
    (action): action is WriteStateAction => action.kind === "writeState" && action.slot.kind === "flag"
  );

  strictEqual(flagWrites.length, x86ArithmeticFlags.length);
  strictEqual(new Set(flagWrites.map((write) => write.slot)).size, x86ArithmeticFlags.length);

  // ...and in the encoding: exactly six byte stores.
  const body = emitActionBlock(block, { body: new WasmFunctionBodyEncoder() }).encode();

  strictEqual(wasmBodyOpcodes(body).filter((opcode) => opcode === wasmOpcode.i32Store8).length, 6);

  const initial: Partial<CpuState> = {
    ebx: 0x7fff_fffe,
    ecx: 0x0000_0001,
    eip: first.address,
    eflags: allArithmeticEflags
  };
  const refState = createCpuState(initial);

  strictEqual(executeDirectInstruction(refState, first).stopReason, StopReason.NONE);
  strictEqual(executeDirectInstruction(refState, second).stopReason, StopReason.NONE);

  const { stateView, run } = await instantiateActionBlock(block);

  writeWasmCpuState(stateView, initial);
  strictEqual(decodeExit(run()).exitReason, ExitReason.FALLTHROUGH);
  assertMatchesReference(stateView, refState, "two adds");
});

function assertMatchesReference(stateView: DataView, refState: CpuState, label: string): void {
  for (const name of reg32) {
    strictEqual(readWasmStateChannel(stateView, gprChannel(name)), refState[name], `${label} ${name}`);
  }

  strictEqual(readWasmStateChannel(stateView, eipChannel), refState.eip, `${label} eip`);

  for (const flag of x86ArithmeticFlags) {
    strictEqual(readWasmFlagByte(stateView, flag), getFlag(refState, flag) ? 1 : 0, `${label} ${flag}`);
  }
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    if (operand.kind !== "reg" || operand.alias.width !== 32) {
      throw new Error(`unsupported operand binding for the flags e2e: ${operand.kind}`);
    }

    return regBinding(operand.alias.base);
  });
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}
