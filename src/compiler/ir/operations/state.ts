import { assert } from "#common/assert.js";
import {
  isDynamicSlot,
  type StateSlot
} from "#ir/slots.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type {
  ValueId,
  ValueInput,
  WidthBounds
} from "#compiler/ir/values/types.js";
import {
  type OperationDefinition,
  type OperationResult
} from "./definition.js";
import {
  emitOperationSlotStore,
  emitSlotLoad,
  stateSlotAccessByteLength
} from "./state-encoding.js";

export type StateReadArgs = Readonly<{
  slot: StateSlot;
  signed?: true;
  accessByteLength?: 1 | 2;
}>;

export const stateRead: OperationDefinition<
  "state.read",
  StateReadArgs,
  OperationResult
> = {
  kind: "state.read",

  create(op) {
    if (op.accessByteLength !== undefined) {
      assert(
        op.accessByteLength < stateSlotAccessByteLength(op.slot),
        "a narrowed slot access must be narrower than the slot"
      );
    }

    return {
      kind: "state.read",
      slot: op.slot,
      ...(op.signed === true ? { signed: true } : {}),
      ...(op.accessByteLength !== undefined
        ? { accessByteLength: op.accessByteLength }
        : {}),
      inputs: slotInputs(op.slot),
      result: stateReadResult(op),
      effects: {
        reads: [{ space: "state", slot: op.slot }],
        writes: []
      }
    };
  },

  emit(operation, target, inputs) {
    emitSlotLoad(
      target,
      operation.slot,
      operation.signed === true,
      inputs,
      operation.accessByteLength
    );
  }
};

type StateWriteArgs = Readonly<{
  slot: StateSlot;
  value: ValueId;
}>;

export const stateWrite: OperationDefinition<
  "state.write",
  StateWriteArgs,
  undefined
> = {
  kind: "state.write",

  create(op) {
    const inputs = slotInputs(op.slot);

    inputs.push({ value: op.value, type: "i32" });

    return {
      kind: "state.write",
      slot: op.slot,
      value: op.value,
      inputs,
      result: undefined,
      effects: {
        reads: [],
        writes: [{ space: "state", slot: op.slot }]
      }
    };
  },

  emit(operation, target, inputs) {
    emitOperationSlotStore(target, operation.slot, inputs);
  }
};

const i32Result: OperationResult = { type: "i32" };

function stateReadResult(op: StateReadArgs): OperationResult {
  const signed = op.signed === true;
  const bounds = op.accessByteLength === undefined
    ? stateReadBounds(op.slot, signed)
    : byteLengthBounds(op.accessByteLength, signed);
  return bounds === undefined ? i32Result : { type: "i32", bounds };
}

function stateReadBounds(slot: StateSlot, signed: boolean): WidthBounds | undefined {
  switch (slot.kind) {
    case "gpr":
    case "gprDynamic":
      return byteLengthBounds(slot.byteLength, signed);
    case "flag":
      return fitsUnsigned(1);
    case "segment":
    case "segmentDynamic":
      return slot.field === "selector" ? fitsUnsigned(16) : undefined;
    case "lazyFlags":
      return slot.field === "lazyFlagsKind" ? fitsUnsigned(8) : undefined;
    case "eip":
    case "instructionCount":
      return undefined;
  }
}

function byteLengthBounds(byteLength: 1 | 2 | 4, signed: boolean): WidthBounds | undefined {
  switch (byteLength) {
    case 1:
      return signed ? signExtended(8) : fitsUnsigned(8);
    case 2:
      return signed ? signExtended(16) : fitsUnsigned(16);
    case 4:
      return undefined;
  }
}

function slotInputs(slot: StateSlot): ValueInput[] {
  if (!isDynamicSlot(slot)) {
    return [];
  }

  const input: ValueInput = { value: slot.index, type: "i32" };

  return [input];
}
