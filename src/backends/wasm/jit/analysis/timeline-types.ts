import type {
  IrExprBlock,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { LoadResultRegistry } from "./load-result.js";

export type ValueSnapshot = JitValueStateSnapshot;

export type StorageReadRef = Readonly<{
  source: IrStorageExpr;
  accessWidth: OperandWidth;
  signed?: boolean;
}>;

export type TimelineExpression = Exclude<IrValueExpr, ValueRef>;

export type SlotWrite = Readonly<{
  opIndex: number;
  slot: JitArchitecturalSlot;
  value: JitValue;
}>;

export type MemoryLoadValue = Readonly<{
  opIndex: number;
  ref: ValueRef;
  value: Extract<JitValue, { kind: "loadResult" }>;
}>;

export type TimelineExpressionId = number & { readonly __timelineExpressionId: unique symbol };
export type TimelineStorageId = number & { readonly __timelineStorageId: unique symbol };
export type TimelineStorageReadId = number & { readonly __timelineStorageReadId: unique symbol };

export type TimelineIdCatalog = Readonly<{
  expressionId(value: TimelineExpression): TimelineExpressionId | undefined;
  storageId(storage: IrStorageExpr): TimelineStorageId | undefined;
  storageReadId(read: StorageReadRef): TimelineStorageReadId | undefined;
}>;

export type TimelineView = Readonly<{
  opIndex: number;
  value(value: IrValueExpr): JitValue;
  expression(value: TimelineExpression): JitValue;
  ref(value: ValueRef): JitValue;
  storageAddress(storage: IrStorageExpr): JitValue;
  storageRead(read: StorageReadRef): JitValue;
  hasValue(value: IrValueExpr): boolean;
  hasExpression(value: TimelineExpression): boolean;
  hasRef(value: ValueRef): boolean;
  hasStorageAddress(storage: IrStorageExpr): boolean;
  hasStorageRead(read: StorageReadRef): boolean;
}>;

export type TimelineStorage = Readonly<{
  catalog: TimelineIdCatalog;
  expressionsByOp?: ReadonlyMap<number, ReadonlyMap<TimelineExpressionId, JitValue>>;
  refsByOp?: ReadonlyMap<number, ReadonlyMap<number, JitValue>>;
  addressesByOp?: ReadonlyMap<number, ReadonlyMap<TimelineStorageId, JitValue>>;
  storageReadsByOp?: ReadonlyMap<number, ReadonlyMap<TimelineStorageReadId, JitValue>>;
}>;

export type Timeline = Readonly<{
  finalState: ValueSnapshot;
  writes: readonly SlotWrite[];
  memoryLoadValues: readonly MemoryLoadValue[];
  viewAt(opIndex: number): TimelineView;
  snapshotAt(opIndex: number): ValueSnapshot;
}>;

export type TimelineInput = Readonly<{
  expressions: IrExprBlock;
  entry?: ValueSnapshot;
  snapshotPoints: ReadonlySet<number>;
  loadResultRegistry: LoadResultRegistry;
}>;
