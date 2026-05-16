import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { JitArchitecturalSlot, JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  jitArchitecturalSlotsOverlap
} from "#backends/wasm/jit/ir/values/slots.js";
import { u32 } from "#x86/state/cpu-state.js";
import type { OperandRef, ValueRef } from "#x86/ir/model/types.js";
import {
  type StorageReadKey,
  type Timeline
} from "./timeline-internals.js";

export type OpView = Readonly<{
  opIndex: number;
  expression(value: IrValueExpr): JitValue | undefined;
  ref(value: ValueRef): JitValue | undefined;
  address(operand: OperandRef): JitValue | undefined;
  storageRead(read: StorageReadKey): JitValue | undefined;
  hasWrite(slot: JitArchitecturalSlot): boolean;
}>;

export function opView(timeline: Timeline, opIndex: number): OpView {
  if (timeline.snapshots[opIndex] === undefined) {
    throw new Error(`missing JIT timeline op view for expression op ${opIndex}`);
  }

  return {
    opIndex,
    expression: (value) => timeline.lookups.expressions[opIndex]?.get(value),
    ref: (value) => valueForRef(timeline, opIndex, value),
    address: (operand) => timeline.lookups.addresses[opIndex]?.get(operand.index),
    storageRead: (read) => timeline.storageReads.find((entry) =>
      entry.opIndex === opIndex &&
        entry.accessWidth === read.accessWidth &&
        entry.signed === (read.signed === true) &&
        storageSourcesEqual(entry.source, read.source)
    )?.value,
    hasWrite: (slot) => timeline.writes.some((entry) =>
      entry.opIndex === opIndex && jitArchitecturalSlotsOverlap(entry.slot, slot)
    )
  };
}

export function requireExpression(view: OpView, value: IrValueExpr, label: string): JitValue {
  return requireTimelineValue(view.expression(value), label, view.opIndex);
}

export function requireValueExpr(
  view: OpView,
  value: IrValueExpr,
  options: Readonly<{ nextEip?: number }> = {}
): JitValue {
  switch (value.kind) {
    case "const":
    case "var":
      return requireTimelineValue(view.ref(value), "JIT value expression", view.opIndex);
    case "nextEip":
      return options.nextEip === undefined
        ? requireTimelineValue(undefined, "JIT value expression", view.opIndex)
        : { kind: "const", type: "i32", value: u32(options.nextEip) };
    case "source":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return requireTimelineValue(view.expression(value), "JIT value expression", view.opIndex);
  }
}

export function requireRef(view: OpView, value: ValueRef, label: string): JitValue {
  return requireTimelineValue(view.ref(value), label, view.opIndex);
}

export function requireStorageAddress(
  view: OpView,
  storage: IrStorageExpr,
  options: Readonly<{ nextEip?: number }> = {}
): JitValue {
  switch (storage.kind) {
    case "mem":
      return requireValueExpr(view, storage.address, options);
    case "operand":
      return requireTimelineValue(view.address(storage), "JIT storage address", view.opIndex);
    case "reg":
      throw new Error(`JIT storage address cannot come from register ${storage.reg}`);
  }
}

export function requireStorageRead(view: OpView, read: StorageReadKey): JitValue {
  return requireTimelineValue(
    view.storageRead(read),
    `JIT storage read ${storageLabel(read.source)}`,
    view.opIndex
  );
}

function valueForRef(timeline: Timeline, opIndex: number, ref: ValueRef): JitValue | undefined {
  switch (ref.kind) {
    case "const":
      return { kind: "const", type: ref.type, value: ref.value };
    case "var":
      return timeline.lookups.refs[opIndex]?.get(ref.id);
    case "nextEip":
      return undefined;
  }
}

function requireTimelineValue(value: JitValue | undefined, label: string, opIndex: number): JitValue {
  if (value === undefined) {
    throw new Error(`${label} is not available in the JIT timeline at expression op ${opIndex}`);
  }

  return value;
}

function storageSourcesEqual(a: IrStorageExpr, b: IrStorageExpr): boolean {
  switch (a.kind) {
    case "reg":
      return b.kind === "reg" && a.reg === b.reg;
    case "operand":
      return b.kind === "operand" && a.index === b.index;
    case "mem":
      return a === b;
  }
}

function storageLabel(storage: IrStorageExpr): string {
  switch (storage.kind) {
    case "reg":
      return storage.reg;
    case "operand":
      return `operand ${storage.index}`;
    case "mem":
      return "memory";
  }
}
