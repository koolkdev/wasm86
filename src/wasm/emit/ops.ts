import { assert } from "#common/assert.js";
import type { IrOp } from "#ir/ops.js";
import type { ValueId } from "#ir/values.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { helperFunctionName, type WasmHelperRegistry } from "#wasm/helpers/module.js";
import { emitGuestLoad, emitGuestStore, emitMemoryCheckFromStack } from "./memory.js";
import { emitSlotLoad, emitSlotStore } from "./state.js";

// How one IR op lowers to wasm, for every op kind: a pure op leaves its
// output on the stack, a mutating op performs its write. Placement decides
// when an op executes — this module only knows how. #ir/ops.js defines
// what an op is; the state and guest access layers own layout and
// addressing.

// A borrowed operand: the first push() takes its one counted use; later
// pushes replay it for free until release().
export type BorrowedUse = Readonly<{
  push(): void;
  release(): void;
}>;

// How op emissions consume operands: push each one exactly once (emitUse)
// or borrow it for repeated observation (borrowUse).
export type OperandUses = Readonly<{
  emitUse(id: ValueId): void;
  borrowUse(id: ValueId): BorrowedUse;
}>;

export function emitOp(
  body: WasmFunctionBodyEncoder,
  helpers: WasmHelperRegistry | undefined,
  op: IrOp,
  operands: OperandUses
): void {
  switch (op.kind) {
    case "state.read":
      emitSlotLoad(body, op.slot, op.signed === true, operands, op.accessByteLength);
      return;
    case "state.write":
      emitSlotStore(body, op.slot, op.value, operands);
      return;
    case "memory.read":
      operands.emitUse(op.address);
      emitGuestLoad(body, op.width, op.signed === true);
      return;
    case "memory.write":
      operands.emitUse(op.address);
      operands.emitUse(op.value);
      emitGuestStore(body, op.width);
      return;
    case "memory.check":
      operands.emitUse(op.address);
      emitMemoryCheckFromStack(body, op.byteLength);
      return;
    case "cpu.resolveFlag": {
      const helper = { kind: "lazyFlag", flag: op.flag } as const;
      const displayName = helperFunctionName(helper);

      assert(helpers !== undefined, `missing Wasm helper ${displayName} in module registry`);
      body.callFunction(helpers.requireFunctionIndex(helper, displayName));
      return;
    }
  }
}
