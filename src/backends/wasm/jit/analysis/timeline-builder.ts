import type {
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import { createJitValueResolver } from "#backends/wasm/jit/analysis/value-resolver.js";
import type {
  JitArchitecturalSlot,
  JitRegisterSlot,
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import {
  jitRegisterSlotForAlias,
  jitRegisterSlotForWrite
} from "#backends/wasm/jit/ir/values/slots.js";
import type { OperandRef, ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth, Reg32 } from "#x86/isa/types.js";
import {
  type PlacedStorageRead,
  type ProducedDefinition,
  type SlotWrite,
  type Timeline,
  type TimelineInput,
  type ValueSnapshot
} from "./timeline-internals.js";
import { ValueStateBuilder, type ValueStateWrite } from "./value-state.js";

export function buildTimeline(input: TimelineInput): Timeline {
  return new TimelineBuilder(input).build();
}

class TimelineBuilder {
  readonly #operands: readonly JitOperandBinding[];
  readonly #ops: readonly IrExprOp[];
  readonly #producedByVar: ReadonlyMap<number, JitProducedValue> | undefined;
  readonly #valueState: ValueStateBuilder;
  readonly #valueRefs = new Map<number, JitValue>();
  readonly #snapshots: ValueSnapshot[] = [];
  readonly #expressions: Map<IrValueExpr, JitValue>[] = [];
  readonly #refs: Map<number, JitValue>[] = [];
  readonly #addresses: Map<number, JitValue>[] = [];
  readonly #storageReads: PlacedStorageRead[] = [];
  readonly #writes: SlotWrite[] = [];
  readonly #produced: ProducedDefinition[] = [];
  readonly #placedRefKeys = new Set<string>();
  #currentOpIndex = -1;
  #currentSetValue: JitValue | undefined;
  #currentSetValueResolved = false;

  constructor(input: TimelineInput) {
    this.#operands = input.operands;
    this.#ops = input.expressions;
    this.#producedByVar = input.producedByVar;
    this.#valueState = new ValueStateBuilder(input.entry);
  }

  build(): Timeline {
    for (let opIndex = 0; opIndex < this.#ops.length; opIndex += 1) {
      const op = this.#ops[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT timeline expression op: ${opIndex}`);
      }

      this.#enterExpressionOp(opIndex);
      this.#recordInputs(op);
      this.#recordMeaning(op);
      this.#recordWrites(op);
      this.#recordProduced(op);
    }

    return this.#finish();
  }

  #enterExpressionOp(opIndex: number): void {
    this.#currentOpIndex = opIndex;
    this.#currentSetValue = undefined;
    this.#currentSetValueResolved = false;
    this.#snapshots[opIndex] = this.#valueState.snapshot();
    this.#expressions[opIndex] = new Map();
    this.#refs[opIndex] = new Map();
    this.#addresses[opIndex] = new Map();
  }

  #recordInputs(op: IrExprOp): void {
    switch (op.op) {
      case "let32":
        if (this.#producedByVar?.has(op.dst.id)) {
          this.#recordNestedValues(op.value);
        }
        return;
      case "set":
        this.#recordStorageInputs(op.target);
        return;
      case "memory.guard":
      case "flags.set":
      case "jump":
      case "conditionalJump":
      case "hostTrap":
      case "next":
        return;
    }
  }

  #recordMeaning(op: IrExprOp): void {
    switch (op.op) {
      case "let32":
        this.#recordLetMeaning(op);
        return;
      case "set":
        this.#currentSetValue = this.#valueForExpression(op.value);
        this.#currentSetValueResolved = true;
        return;
      case "memory.guard":
        this.#valueForExpression(op.address);
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
      case "flags.set":
      case "next":
        return;
    }
  }

  #recordWrites(op: IrExprOp): void {
    switch (op.op) {
      case "set":
        this.#recordSetWrite(op);
        return;
      case "flags.set":
        this.#recordFlagWrite(op);
        return;
      case "let32":
      case "memory.guard":
      case "jump":
      case "conditionalJump":
      case "hostTrap":
      case "next":
        return;
    }
  }

  #recordProduced(op: IrExprOp): void {
    if (op.op !== "let32") {
      return;
    }

    const produced = this.#producedByVar?.get(op.dst.id);

    if (produced === undefined) {
      return;
    }

    this.#produced.push({
      opIndex: this.#currentOpIndex,
      ref: op.dst,
      value: produced
    });
  }

  #finish(): Timeline {
    for (let opIndex = 0; opIndex < this.#ops.length; opIndex += 1) {
      if (
        this.#snapshots[opIndex] === undefined ||
        this.#expressions[opIndex] === undefined ||
        this.#refs[opIndex] === undefined ||
        this.#addresses[opIndex] === undefined
      ) {
        throw new Error(`missing JIT timeline data for expression op ${opIndex}`);
      }
    }

    return {
      snapshots: [...this.#snapshots],
      final: this.#valueState.snapshot(),
      storageReads: [...this.#storageReads],
      writes: [...this.#writes],
      produced: [...this.#produced],
      lookups: {
        expressions: this.#expressions.map((values) => new Map(values)),
        refs: this.#refs.map((values) => new Map(values)),
        addresses: this.#addresses.map((values) => new Map(values))
      }
    };
  }

  #recordLetMeaning(op: Extract<IrExprOp, { op: "let32" }>): void {
    const produced = this.#producedByVar?.get(op.dst.id);
    const value = produced ?? this.#valueForExpression(op.value);

    if (produced !== undefined) {
      this.#recordExpressionValue(op.value, produced);
    }

    if (value === undefined) {
      this.#valueRefs.delete(op.dst.id);
      return;
    }

    this.#valueRefs.set(op.dst.id, value);
    this.#recordRefValue(op.dst, value);
  }

  #recordSetWrite(op: Extract<IrExprOp, { op: "set" }>): void {
    const value = this.#currentSetValueResolved
      ? this.#currentSetValue
      : this.#valueForExpression(op.value);

    switch (op.target.kind) {
      case "mem":
        return;
      case "reg":
        this.#recordRegisterWrite(op.target.reg, 0, op.accessWidth, value);
        return;
      case "operand":
        this.#recordOperandWrite(op.target.index, value);
        return;
    }
  }

  #recordOperandWrite(operandIndex: number, value: JitValue | undefined): void {
    const binding = this.#operands[operandIndex];

    if (binding === undefined) {
      throw new Error(`missing JIT operand binding for register write at expression op ${this.#currentOpIndex}`);
    }

    switch (binding.kind) {
      case "static.reg":
        this.#recordRegisterSlotWrite(jitRegisterSlotForAlias(binding.alias), value);
        return;
      case "static.mem":
      case "static.imm32":
      case "static.relTarget":
        return;
    }
  }

  #recordRegisterWrite(
    reg: Reg32,
    bitOffset: number,
    width: OperandWidth,
    value: JitValue | undefined
  ): void {
    if (value === undefined) {
      throw new Error(`could not resolve JIT timeline register write at expression op ${this.#currentOpIndex}`);
    }

    this.#recordRegisterSlotWrite(jitRegisterSlotForWrite(reg, bitOffset, width), value);
  }

  #recordRegisterSlotWrite(slot: JitRegisterSlot, value: JitValue | undefined): void {
    if (value === undefined) {
      throw new Error(`could not resolve JIT timeline register write at expression op ${this.#currentOpIndex}`);
    }

    const write = this.#recordRegisterSlotSet(slot, value);

    this.#recordWrite(write.slot, write.value);
  }

  #recordRegisterSlotSet(slot: JitRegisterSlot, value: JitValue): ValueStateWrite {
    switch (slot.kind) {
      case "reg32":
        return this.#valueState.registers().recordReg32(slot.reg, value);
      case "reg16":
        return this.#valueState.registers().recordReg16(slot.reg, value);
      case "reg8":
        return this.#valueState.registers().recordReg8(slot.reg, value);
    }
  }

  #recordFlagWrite(op: Extract<IrExprOp, { op: "flags.set" }>): void {
    const write = this.#valueState.flags().recordSet(op, () => this.#inputRecordFor(op.inputs));

    if (write !== undefined) {
      this.#recordWrite(write.slot, write.value);
    }
  }

  #inputRecordFor(inputs: Readonly<Record<string, ValueRef>>): Readonly<Record<string, JitValue>> {
    const resolved: Record<string, JitValue> = {};

    for (const [name, value] of Object.entries(inputs)) {
      resolved[name] = this.#requiredValueForRef(value);
    }

    return resolved;
  }

  #recordStorageInputs(storage: IrStorageExpr): void {
    switch (storage.kind) {
      case "mem":
        this.#valueForExpression(storage.address);
        return;
      case "operand":
        this.#recordAddress(storage);
        return;
      case "reg":
        return;
    }
  }

  #recordAddress(operand: OperandRef): void {
    const value = this.#resolver().valueForEffectiveAddress(operand);

    if (value === undefined) {
      return;
    }

    const values = this.#currentAddressValues();

    if (values.has(operand.index)) {
      return;
    }

    values.set(operand.index, value);
  }

  #valueForExpression(expression: IrValueExpr): JitValue | undefined {
    switch (expression.kind) {
      case "var":
      case "const":
      case "nextEip":
        return this.#recordResolvedExpression(expression, this.#valueForRef(expression));
      case "source": {
        this.#recordStorageInputs(expression.source);
        const value = this.#resolver().valueForExpression(expression);

        this.#recordStorageRead(expression, value);
        return this.#recordResolvedExpression(expression, value);
      }
      case "address": {
        this.#recordAddress(expression.operand);
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

  #recordNestedValues(expression: IrValueExpr): void {
    switch (expression.kind) {
      case "var":
      case "const":
      case "nextEip":
        this.#valueForRef(expression);
        return;
      case "source":
        this.#recordStorageInputs(expression.source);
        this.#recordStorageRead(expression, this.#resolver().valueForExpression(expression));
        return;
      case "address":
        this.#recordAddress(expression.operand);
        return;
      case "value.binary":
        this.#recordNestedValues(expression.a);
        this.#recordNestedValues(expression.b);
        return;
      case "value.unary":
        this.#recordNestedValues(expression.value);
        return;
      case "value.select":
        this.#recordNestedValues(expression.condition);
        this.#recordNestedValues(expression.whenTrue);
        this.#recordNestedValues(expression.whenFalse);
        return;
      case "flags.condition":
        return;
    }
  }

  #requiredValueForRef(ref: ValueRef): JitValue {
    const resolved = this.#valueForRef(ref);

    if (resolved === undefined) {
      throw new Error(`could not resolve ${valueRefLabel(ref)} in JIT timeline`);
    }

    return resolved;
  }

  #valueForRef(ref: ValueRef): JitValue | undefined {
    const resolved = this.#resolver().valueForValueRef(ref);

    if (resolved !== undefined) {
      this.#recordRefValue(ref, resolved);
    }

    return resolved;
  }

  #resolver() {
    return createJitValueResolver({
      operands: this.#operands,
      readReg32: (reg) => this.#valueState.registers().readReg32(reg),
      readAluFlags: () => this.#valueState.flags().readAluFlags(),
      readValueRef: (value) =>
        value.kind === "var" ? this.#valueRefs.get(value.id) : undefined
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
  }

  #recordRefValue(ref: ValueRef, value: JitValue): void {
    if (ref.kind !== "var") {
      return;
    }

    const key = `${this.#currentOpIndex}:${valueRefKey(ref)}`;

    if (this.#placedRefKeys.has(key)) {
      return;
    }

    this.#placedRefKeys.add(key);
    this.#currentRefValues().set(ref.id, value);
  }

  #recordStorageRead(expression: Extract<IrValueExpr, { kind: "source" }>, value: JitValue | undefined): void {
    this.#storageReads.push({
      opIndex: this.#currentOpIndex,
      source: expression.source,
      accessWidth: expression.accessWidth,
      signed: expression.signed === true,
      ...(value === undefined ? {} : { value })
    });
  }

  #recordWrite(slot: JitArchitecturalSlot, value: JitValue): void {
    this.#writes.push({
      opIndex: this.#currentOpIndex,
      slot,
      value
    });
  }

  #currentExpressionValues(): Map<IrValueExpr, JitValue> {
    const values = this.#expressions[this.#currentOpIndex];

    if (values === undefined) {
      throw new Error(`missing JIT timeline expression values for op ${this.#currentOpIndex}`);
    }

    return values;
  }

  #currentRefValues(): Map<number, JitValue> {
    const values = this.#refs[this.#currentOpIndex];

    if (values === undefined) {
      throw new Error(`missing JIT timeline value-ref values for op ${this.#currentOpIndex}`);
    }

    return values;
  }

  #currentAddressValues(): Map<number, JitValue> {
    const values = this.#addresses[this.#currentOpIndex];

    if (values === undefined) {
      throw new Error(`missing JIT timeline effective-address values for op ${this.#currentOpIndex}`);
    }

    return values;
  }
}

function valueRefKey(ref: ValueRef): string {
  switch (ref.kind) {
    case "var":
      return `var:${ref.id}`;
    case "const":
      return `const:${ref.type}:${ref.value}`;
    case "nextEip":
      return "nextEip";
  }
}

function valueRefLabel(ref: ValueRef): string {
  switch (ref.kind) {
    case "var":
      return `var ${ref.id}`;
    case "const":
      return `const ${ref.value}`;
    case "nextEip":
      return "nextEip";
  }
}
