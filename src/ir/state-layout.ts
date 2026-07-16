import { widthByteLength, type ArrayRef, type FieldRef } from "#compiler/layout/handles.js";
import { createLayout } from "#compiler/layout/layout.js";
import { cpuExecutionState, cpuExecutionStateFields } from "#cpu/execution-state.js";
import { flagState, flagStateFields } from "#core/flags/state.js";
import { coreState, coreStateFields, type SegmentStateField } from "#core/state/fields.js";
import type { StateSlot } from "./slots.js";

export const executionStateLayout = createLayout("execution-state", [
  coreState,
  flagState,
  cpuExecutionState
]);

// The state-slot address form over the execution-state layout. It is
// x86-shaped (byteOffset selects a narrow GPR alias), not neutral layout
// vocabulary: 04d replaces it with the compiler's layout range facts when
// effects re-key and the slot family dissolves.
export type StateLocation =
  | Readonly<{ kind: "field"; field: FieldRef }>
  | Readonly<{
      kind: "element";
      array: ArrayRef;
      index: number;
      byteOffset: 0 | 1;
      byteLength: 1 | 2 | 4;
    }>
  | Readonly<{ kind: "array"; array: ArrayRef }>;

export function stateSlotLocation(slot: StateSlot): StateLocation {
  switch (slot.kind) {
    case "gpr":
      return {
        kind: "element",
        array: coreStateFields.gprs,
        index: coreStateFields.gprs.elementIndex(slot.reg),
        byteOffset: slot.byteOffsetInReg,
        byteLength: slot.byteLength
      };
    case "gprDynamic":
      return { kind: "array", array: coreStateFields.gprs };
    case "flag":
      return { kind: "field", field: flagStateFields.concrete[slot.flag] };
    case "segment": {
      const array = segmentArray(slot.field);

      return {
        kind: "element",
        array,
        index: array.elementIndex(slot.reg),
        byteOffset: 0,
        byteLength: widthByteLength(array.elementWidth)
      };
    }
    case "segmentDynamic":
      return { kind: "array", array: segmentArray(slot.field) };
    case "eip":
      return { kind: "field", field: coreStateFields.eip };
    case "instructionCount":
      return { kind: "field", field: cpuExecutionStateFields.instructionCount };
    case "lazyFlags":
      switch (slot.field) {
        case "lazyFlagsKind":
          return { kind: "field", field: flagStateFields.lazyKind };
        case "lazyFlagsA":
          return { kind: "field", field: flagStateFields.lazyA };
        case "lazyFlagsB":
          return { kind: "field", field: flagStateFields.lazyB };
      }
  }
}

function segmentArray(field: SegmentStateField): ArrayRef<"u16" | "u32"> {
  switch (field) {
    case "selector":
      return coreStateFields.segmentSelectors;
    case "base":
      return coreStateFields.segmentBases;
    case "limit":
      return coreStateFields.segmentLimits;
    case "access":
      return coreStateFields.segmentAccess;
  }
}
