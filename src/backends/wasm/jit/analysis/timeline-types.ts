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
import type { OperandRef, ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";

export type ValueSnapshot = JitValueStateSnapshot;

export type RegisterStorageReadSource = Extract<IrStorageExpr, { kind: "operand" | "reg" }>;

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

export type ProducedDefinition = Readonly<{
  opIndex: number;
  ref: ValueRef;
  value: JitProducedValue;
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
  address(operand: OperandRef): JitValue;
  storageRead(read: StorageReadRef): JitValue;
  hasValue(value: IrValueExpr): boolean;
  hasExpression(value: TimelineExpression): boolean;
  hasRef(value: ValueRef): boolean;
  hasStorageAddress(storage: IrStorageExpr): boolean;
  hasAddress(operand: OperandRef): boolean;
  hasStorageRead(read: StorageReadRef): boolean;
}>;

export type TimelineStorage = Readonly<{
  catalog: TimelineIdCatalog;
  nextEip?: JitValue;
  expressionsByOp?: ReadonlyMap<number, ReadonlyMap<TimelineExpressionId, JitValue>>;
  refsByOp?: ReadonlyMap<number, ReadonlyMap<number, JitValue>>;
  addressesByOp?: ReadonlyMap<number, ReadonlyMap<TimelineStorageId, JitValue>>;
  storageReadsByOp?: ReadonlyMap<number, ReadonlyMap<TimelineStorageReadId, JitValue>>;
}>;

export type Timeline = Readonly<{
  finalState: ValueSnapshot;
  writes: readonly SlotWrite[];
  produced: readonly ProducedDefinition[];
  viewAt(opIndex: number): TimelineView;
  snapshotAt(opIndex: number): ValueSnapshot;
}>;

export type TimelineInput = Readonly<{
  operands: readonly JitOperandBinding[];
  expressions: IrExprBlock;
  entry: ValueSnapshot;
  nextEip?: number;
  producedByVar?: ReadonlyMap<number, JitProducedValue>;
}>;
