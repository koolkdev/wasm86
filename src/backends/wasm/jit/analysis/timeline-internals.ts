import type {
  IrExprBlock,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type {
  JitArchitecturalSlot,
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";

export type ValueSnapshot = JitValueStateSnapshot;

export type PlacedStorageRead = Readonly<{
  opIndex: number;
  source: IrStorageExpr;
  accessWidth: OperandWidth;
  signed: boolean;
  value?: JitValue;
}>;

export type RegisterStorageReadSource = Extract<IrStorageExpr, { kind: "operand" | "reg" }>;

export type StorageReadKey = Readonly<{
  source: IrStorageExpr;
  accessWidth: OperandWidth;
  signed?: boolean;
}>;

export type SlotWrite = Readonly<{
  opIndex: number;
  slot: JitArchitecturalSlot;
  value: JitValue;
}>;

export type ProducedDefinition = Readonly<{
  opIndex: number;
  ref: ValueRef;
  value: JitProducedValue;
}>;

export type TimelineLookups = Readonly<{
  expressions: readonly ReadonlyMap<IrValueExpr, JitValue>[];
  refs: readonly ReadonlyMap<number, JitValue>[];
  addresses: readonly ReadonlyMap<number, JitValue>[];
}>;

export type Timeline = Readonly<{
  snapshots: readonly ValueSnapshot[];
  final: ValueSnapshot;
  storageReads: readonly PlacedStorageRead[];
  writes: readonly SlotWrite[];
  produced: readonly ProducedDefinition[];
  lookups: TimelineLookups;
}>;

export type TimelineInput = Readonly<{
  operands: readonly JitOperandBinding[];
  expressions: IrExprBlock;
  entry: ValueSnapshot;
  producedByVar?: ReadonlyMap<number, JitProducedValue>;
}>;
