import type {
  IrExprBlock,
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import { createJitValueResolver } from "#backends/wasm/jit/ir/value-resolver.js";
import {
  type JitArchitecturalSlot,
  type JitProducedValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import {
  createJitValueStateFromSnapshot,
  type JitValueState,
  type JitValueStateSnapshot
} from "#backends/wasm/jit/state/value-state.js";
import type { OperandRef, ValueRef } from "#x86/ir/model/types.js";
import {
  jitFlagSetProducerValue,
  jitFlagSetWrittenMask
} from "./flag-values.js";
import { jitStorageRegisterAlias } from "./operand-analysis.js";
import type { OperandWidth } from "#x86/isa/types.js";

export type JitPlacedExpressionValue = Readonly<{
  expressionOpIndex: number;
  expression: IrValueExpr;
  value: JitValue;
}>;

export type JitPlacedValueRefValue = Readonly<{
  expressionOpIndex: number;
  valueRef: ValueRef;
  value: JitValue;
}>;

export type JitPlacedEffectiveAddressValue = Readonly<{
  expressionOpIndex: number;
  operand: OperandRef;
  value: JitValue;
}>;

export type JitPlacedStorageRead = Readonly<{
  expressionOpIndex: number;
  source: IrStorageExpr;
  accessWidth: OperandWidth;
  signed: boolean;
  value?: JitValue;
}>;

export type JitValueTimelineWrite = Readonly<{
  expressionOpIndex: number;
  slot: JitArchitecturalSlot;
  value: JitValue;
}>;

export type JitInstructionValueTimeline = Readonly<{
  entryValueState: JitValueStateSnapshot;
  valueStateSnapshotsByExpressionOpIndex: readonly JitValueStateSnapshot[];
  finalValueState: JitValueStateSnapshot;
  expressionValuesByExpressionOpIndex: readonly ReadonlyMap<IrValueExpr, JitValue>[];
  valueRefValuesByExpressionOpIndex: readonly ReadonlyMap<number, JitValue>[];
  effectiveAddressValuesByExpressionOpIndex: readonly ReadonlyMap<number, JitValue>[];
  placedExpressionValues: readonly JitPlacedExpressionValue[];
  placedValueRefValues: readonly JitPlacedValueRefValue[];
  placedEffectiveAddressValues: readonly JitPlacedEffectiveAddressValue[];
  placedStorageReads: readonly JitPlacedStorageRead[];
  logicalWrites: readonly JitValueTimelineWrite[];
}>;

export type JitInstructionValueTimelineInput = Readonly<{
  operands: readonly JitOperandBinding[];
  expressionBlock: IrExprBlock;
  entryValueState: JitValueStateSnapshot;
  producedValuesByVarId?: ReadonlyMap<number, JitProducedValue>;
}>;

export function buildJitInstructionValueTimeline(
  input: JitInstructionValueTimelineInput
): JitInstructionValueTimeline {
  return new JitInstructionValueTimelineBuilder(input).build();
}

class JitInstructionValueTimelineBuilder {
  readonly #operands: readonly JitOperandBinding[];
  readonly #expressionBlock: IrExprBlock;
  readonly #entryValueState: JitValueStateSnapshot;
  readonly #producedValuesByVarId: ReadonlyMap<number, JitProducedValue> | undefined;
  readonly #valueState: JitValueState;
  readonly #valueRefs = new Map<number, JitValue>();
  readonly #valueStateSnapshotsByExpressionOpIndex: JitValueStateSnapshot[] = [];
  readonly #expressionValuesByExpressionOpIndex: Map<IrValueExpr, JitValue>[] = [];
  readonly #valueRefValuesByExpressionOpIndex: Map<number, JitValue>[] = [];
  readonly #effectiveAddressValuesByExpressionOpIndex: Map<number, JitValue>[] = [];
  readonly #placedExpressionValues: JitPlacedExpressionValue[] = [];
  readonly #placedValueRefValues: JitPlacedValueRefValue[] = [];
  readonly #placedEffectiveAddressValues: JitPlacedEffectiveAddressValue[] = [];
  readonly #placedStorageReads: JitPlacedStorageRead[] = [];
  readonly #logicalWrites: JitValueTimelineWrite[] = [];
  readonly #placedValueRefKeys = new Set<string>();
  #currentExpressionOpIndex = -1;

  constructor(input: JitInstructionValueTimelineInput) {
    this.#operands = input.operands;
    this.#expressionBlock = input.expressionBlock;
    this.#entryValueState = input.entryValueState;
    this.#producedValuesByVarId = input.producedValuesByVarId;
    this.#valueState = createJitValueStateFromSnapshot(input.entryValueState);
  }

  build(): JitInstructionValueTimeline {
    for (let expressionOpIndex = 0; expressionOpIndex < this.#expressionBlock.length; expressionOpIndex += 1) {
      const op = this.#expressionBlock[expressionOpIndex];

      if (op === undefined) {
        throw new Error(`missing JIT value timeline expression op: ${expressionOpIndex}`);
      }

      this.#beginExpressionOp(expressionOpIndex);
      this.#recordOp(op);
    }

    return {
      entryValueState: this.#entryValueState,
      valueStateSnapshotsByExpressionOpIndex: this.#valueStateSnapshotsByExpressionOpIndex,
      finalValueState: this.#valueState.snapshot(),
      expressionValuesByExpressionOpIndex: this.#expressionValuesByExpressionOpIndex,
      valueRefValuesByExpressionOpIndex: this.#valueRefValuesByExpressionOpIndex,
      effectiveAddressValuesByExpressionOpIndex: this.#effectiveAddressValuesByExpressionOpIndex,
      placedExpressionValues: this.#placedExpressionValues,
      placedValueRefValues: this.#placedValueRefValues,
      placedEffectiveAddressValues: this.#placedEffectiveAddressValues,
      placedStorageReads: this.#placedStorageReads,
      logicalWrites: this.#logicalWrites
    };
  }

  #beginExpressionOp(expressionOpIndex: number): void {
    this.#currentExpressionOpIndex = expressionOpIndex;
    this.#valueStateSnapshotsByExpressionOpIndex[expressionOpIndex] = this.#valueState.snapshot();
    this.#expressionValuesByExpressionOpIndex[expressionOpIndex] = new Map();
    this.#valueRefValuesByExpressionOpIndex[expressionOpIndex] = new Map();
    this.#effectiveAddressValuesByExpressionOpIndex[expressionOpIndex] = new Map();
  }

  #recordOp(op: IrExprOp): void {
    switch (op.op) {
      case "let32":
        this.#recordLet(op);
        return;
      case "set":
        this.#recordSet(op);
        return;
      case "flags.set":
        this.#recordFlagSet(op);
        return;
      case "jump":
        this.#valueForExpression(op.target);
        return;
      case "conditionalJump":
        this.#valueForExpression(op.condition);
        this.#valueForExpression(op.taken);
        this.#valueForExpression(op.notTaken);
        return;
      case "hostTrap":
        this.#valueForExpression(op.vector);
        return;
      case "next":
        return;
    }
  }

  #recordLet(op: Extract<IrExprOp, { op: "let32" }>): void {
    const producedValue = this.#producedValuesByVarId?.get(op.dst.id);
    const value = producedValue ?? this.#valueForExpression(op.value);

    if (producedValue !== undefined) {
      this.#recordNestedObservations(op.value);
      this.#recordExpressionValue(op.value, producedValue);
    }

    if (value === undefined) {
      this.#valueRefs.delete(op.dst.id);
      return;
    }

    this.#valueRefs.set(op.dst.id, value);
    this.#recordValueRefValue(op.dst, value);
  }

  #recordSet(op: Extract<IrExprOp, { op: "set" }>): void {
    this.#recordStorageInputs(op.target);
    const value = this.#valueForExpression(op.value);

    if (op.role === "registerMaterialization") {
      return;
    }

    const alias = jitStorageRegisterAlias(
      { operands: this.#operands },
      op.target,
      op.accessWidth
    );

    if (alias === undefined) {
      return;
    }

    if (value === undefined) {
      throw new Error(`could not resolve JIT value timeline register write at expression op ${this.#currentExpressionOpIndex}`);
    }

    if (alias.width === 32 && alias.bitOffset === 0) {
      this.#valueState.regs.writeReg32(alias.base, value);
    } else {
      this.#valueState.regs.writeRegPart(alias.base, alias.bitOffset, alias.width, value);
    }

    this.#recordLogicalWrite({
      kind: "reg32",
      reg: alias.base
    }, this.#valueState.regs.readReg32(alias.base));
  }

  #recordFlagSet(op: Extract<IrExprOp, { op: "flags.set" }>): void {
    const mask = jitFlagSetWrittenMask(op);

    if (mask === 0) {
      return;
    }

    const producer = jitFlagSetProducerValue(op, this.#inputRecordFor(op.inputs));

    this.#valueState.flags.writeFlagBits(mask, producer);
    this.#recordLogicalWrite({ kind: "aluFlags" }, this.#valueState.flags.readAluFlags());
  }

  #inputRecordFor(inputs: Readonly<Record<string, ValueRef>>): Readonly<Record<string, JitValue>> {
    const resolved: Record<string, JitValue> = {};

    for (const [name, value] of Object.entries(inputs)) {
      resolved[name] = this.#requiredValueForValueRef(value);
    }

    return resolved;
  }

  #recordStorageInputs(storage: IrStorageExpr): void {
    switch (storage.kind) {
      case "mem":
        this.#valueForExpression(storage.address);
        return;
      case "operand":
        this.#recordEffectiveAddress(storage);
        return;
      case "reg":
        return;
    }
  }

  #recordEffectiveAddress(operand: OperandRef): void {
    const value = this.#resolver().valueForEffectiveAddress(operand);

    if (value === undefined) {
      return;
    }

    const values = this.#currentEffectiveAddressValues();

    if (values.has(operand.index)) {
      return;
    }

    values.set(operand.index, value);
    this.#placedEffectiveAddressValues.push({
      expressionOpIndex: this.#currentExpressionOpIndex,
      operand,
      value
    });
  }

  #valueForExpression(expression: IrValueExpr): JitValue | undefined {
    switch (expression.kind) {
      case "var":
      case "const":
      case "nextEip":
        return this.#recordResolvedExpression(expression, this.#valueForValueRef(expression));
      case "source": {
        this.#recordStorageInputs(expression.source);
        const value = this.#resolver().valueForExpression(expression);

        this.#recordStorageRead(expression, value);
        return this.#recordResolvedExpression(expression, value);
      }
      case "address": {
        this.#recordEffectiveAddress(expression.operand);
        return this.#recordResolvedExpression(expression, this.#resolver().valueForExpression(expression));
      }
      case "value.binary":
        this.#valueForExpression(expression.a);
        this.#valueForExpression(expression.b);
        return this.#recordResolvedExpression(expression, this.#resolver().valueForExpression(expression));
      case "value.unary":
        this.#valueForExpression(expression.value);
        return this.#recordResolvedExpression(expression, this.#resolver().valueForExpression(expression));
      case "value.select":
        this.#valueForExpression(expression.condition);
        this.#valueForExpression(expression.whenTrue);
        this.#valueForExpression(expression.whenFalse);
        return this.#recordResolvedExpression(expression, this.#resolver().valueForExpression(expression));
      case "flags.condition":
        return this.#recordResolvedExpression(expression, this.#resolver().valueForExpression(expression));
    }
  }

  #recordNestedObservations(expression: IrValueExpr): void {
    switch (expression.kind) {
      case "var":
      case "const":
      case "nextEip":
        this.#valueForValueRef(expression);
        return;
      case "source": {
        this.#recordStorageInputs(expression.source);
        this.#recordStorageRead(expression, this.#resolver().valueForExpression(expression));
        return;
      }
      case "address":
        this.#recordEffectiveAddress(expression.operand);
        return;
      case "value.binary":
        this.#recordNestedObservations(expression.a);
        this.#recordNestedObservations(expression.b);
        return;
      case "value.unary":
        this.#recordNestedObservations(expression.value);
        return;
      case "value.select":
        this.#recordNestedObservations(expression.condition);
        this.#recordNestedObservations(expression.whenTrue);
        this.#recordNestedObservations(expression.whenFalse);
        return;
      case "flags.condition":
        return;
    }
  }

  #requiredValueForValueRef(value: ValueRef): JitValue {
    const resolved = this.#valueForValueRef(value);

    if (resolved === undefined) {
      throw new Error(`could not resolve ${valueRefLabel(value)} in JIT value timeline`);
    }

    return resolved;
  }

  #valueForValueRef(value: ValueRef): JitValue | undefined {
    const resolved = this.#resolver().valueForValueRef(value);

    if (resolved !== undefined) {
      this.#recordValueRefValue(value, resolved);
    }

    return resolved;
  }

  #resolver() {
    return createJitValueResolver({
      operands: this.#operands,
      readReg32: (reg) => this.#valueState.regs.readReg32(reg),
      readAluFlags: () => this.#valueState.flags.readAluFlags(),
      readValueRef: (value) =>
        value.kind === "var" ? this.#valueRefs.get(value.id) : undefined,
    });
  }

  #recordResolvedExpression(expression: IrValueExpr, value: JitValue | undefined): JitValue | undefined {
    if (value !== undefined) {
      this.#recordExpressionValue(expression, value);
    }

    return value;
  }

  #recordExpressionValue(expression: IrValueExpr, value: JitValue): void {
    const values = this.#currentExpressionValues();

    if (values.has(expression)) {
      return;
    }

    values.set(expression, value);
    this.#placedExpressionValues.push({
      expressionOpIndex: this.#currentExpressionOpIndex,
      expression,
      value
    });
  }

  #recordValueRefValue(valueRef: ValueRef, value: JitValue): void {
    if (valueRef.kind !== "var") {
      return;
    }

    const key = `${this.#currentExpressionOpIndex}:${valueRefKey(valueRef)}`;

    if (this.#placedValueRefKeys.has(key)) {
      return;
    }

    this.#placedValueRefKeys.add(key);

    this.#currentValueRefValues().set(valueRef.id, value);
    this.#placedValueRefValues.push({
      expressionOpIndex: this.#currentExpressionOpIndex,
      valueRef,
      value
    });
  }

  #recordStorageRead(expression: Extract<IrValueExpr, { kind: "source" }>, value: JitValue | undefined): void {
    this.#placedStorageReads.push({
      expressionOpIndex: this.#currentExpressionOpIndex,
      source: expression.source,
      accessWidth: expression.accessWidth,
      signed: expression.signed === true,
      ...(value === undefined ? {} : { value })
    });
  }

  #recordLogicalWrite(slot: JitArchitecturalSlot, value: JitValue): void {
    this.#logicalWrites.push({
      expressionOpIndex: this.#currentExpressionOpIndex,
      slot,
      value
    });
  }

  #currentExpressionValues(): Map<IrValueExpr, JitValue> {
    const values = this.#expressionValuesByExpressionOpIndex[this.#currentExpressionOpIndex];

    if (values === undefined) {
      throw new Error(`missing JIT value timeline expression values for op ${this.#currentExpressionOpIndex}`);
    }

    return values;
  }

  #currentValueRefValues(): Map<number, JitValue> {
    const values = this.#valueRefValuesByExpressionOpIndex[this.#currentExpressionOpIndex];

    if (values === undefined) {
      throw new Error(`missing JIT value timeline value-ref values for op ${this.#currentExpressionOpIndex}`);
    }

    return values;
  }

  #currentEffectiveAddressValues(): Map<number, JitValue> {
    const values = this.#effectiveAddressValuesByExpressionOpIndex[this.#currentExpressionOpIndex];

    if (values === undefined) {
      throw new Error(`missing JIT value timeline effective-address values for op ${this.#currentExpressionOpIndex}`);
    }

    return values;
  }
}

function valueRefKey(value: ValueRef): string {
  switch (value.kind) {
    case "var":
      return `var:${value.id}`;
    case "const":
      return `const:${value.type}:${value.value}`;
    case "nextEip":
      return "nextEip";
  }
}

function valueRefLabel(value: ValueRef): string {
  switch (value.kind) {
    case "var":
      return `var ${value.id}`;
    case "const":
      return `const ${value.value}`;
    case "nextEip":
      return "nextEip";
  }
}
