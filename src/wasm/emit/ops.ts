import { assert } from "#common/assert.js";
import type { IrOp } from "#ir/ops.js";
import type { ValueId } from "#ir/values.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { helperFunctionName } from "#wasm/helpers/key.js";
import type { LegacyHelperIndexRegistryAdapter } from "#wasm/helpers/registry.js";
import { emitGuestLoad, emitGuestStore, emitMemoryCheck } from "./memory.js";
import { emitSlotLoad, emitSlotStore } from "./state.js";

// How one IR op lowers to wasm, for every op kind: a pure op leaves its
// output on the stack, a mutating op performs its write. The action emitter
// decides when an op executes — this module only knows how. #ir/ops.js defines
// what an op is; the state and guest access layers own layout and
// addressing.

// A borrowed operand: the first push() takes its one counted use; later
// pushes replay it for free within the callback scope.
export type BorrowedUse = Readonly<{
  push(): void;
}>;

// How op emissions consume operands: push each one exactly once (emitUse)
// or borrow it for repeated observation within a synchronous scope.
export type OperandUses = Readonly<{
  emitUse(id: ValueId): void;
  withBorrowedUse(id: ValueId, callback: (borrowed: BorrowedUse) => void): void;
  constValue(id: ValueId): number | undefined;
  // The wasm local backing a semantic var, stable for the fragment.
  varLocal(variable: number): number;
}>;

export function emitOp(
  body: WasmFunctionBodyEncoder,
  helpers: LegacyHelperIndexRegistryAdapter | undefined,
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
      emitGuestLoad(body, op.width, op.signed === true, op.byteOffset);
      return;
    case "memory.write":
      operands.emitUse(op.address);
      operands.emitUse(op.value);
      emitGuestStore(body, op.width, op.byteOffset);
      return;
    case "memory.check":
    case "memory.resolve":
      emitMemoryCheck(body, operands, op.address, op.byteLength);
      return;
    case "var.read":
      body.localGet(operands.varLocal(op.variable));
      return;
    case "var.write":
      operands.emitUse(op.value);
      body.localSet(operands.varLocal(op.variable));
      return;
    case "cpu.resolveFlag": {
      const helper = { kind: "lazyFlag", flag: op.flag } as const;
      const displayName = helperFunctionName(helper);

      assert(helpers !== undefined, `missing Wasm helper ${displayName} in module registry`);
      const functionIndex = helpers.functionIndex(helper);

      assert(functionIndex !== undefined, `missing Wasm helper ${displayName} in resolved index registry`);
      body.callFunction(functionIndex);
      return;
    }
  }
}
