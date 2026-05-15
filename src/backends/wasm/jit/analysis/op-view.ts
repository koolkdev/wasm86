import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { JitArchitecturalSlot, JitValue } from "#backends/wasm/jit/ir/values/types.js";
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
      entry.opIndex === opIndex && slotsEqual(entry.slot, slot)
    )
  };
}

export function requireExpression(view: OpView, value: IrValueExpr, label: string): JitValue {
  return requireTimelineValue(view.expression(value), label, view.opIndex);
}

export function requireRef(view: OpView, value: ValueRef, label: string): JitValue {
  return requireTimelineValue(view.ref(value), label, view.opIndex);
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

function slotsEqual(a: JitArchitecturalSlot, b: JitArchitecturalSlot): boolean {
  switch (a.kind) {
    case "reg32":
      return b.kind === "reg32" && a.reg === b.reg;
    case "aluFlags":
      return b.kind === "aluFlags";
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
