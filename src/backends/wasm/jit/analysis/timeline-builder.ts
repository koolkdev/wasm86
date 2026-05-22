import type {
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import {
  createJitValueResolver,
  type JitValueResolver
} from "#backends/wasm/jit/analysis/value-resolver.js";
import type { BlockExprOp } from "#backends/wasm/jit/ir/block-expressions.js";
import type {
  JitArchitecturalSlot,
  JitRegisterSlot,
  JitLoadResultValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import {
  jitRegisterSlotForAlias
} from "#backends/wasm/jit/ir/values/slots.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import { registerAlias } from "#x86/isa/registers.js";
import type { OperandWidth, RegisterAlias, RegName } from "#x86/isa/types.js";
import { LoadResultRegistry } from "./load-result.js";
import {
  type MemoryLoadValue,
  type SlotWrite,
  type Timeline,
  type TimelineExpression,
  type TimelineExpressionId,
  type TimelineInput,
  type TimelineStorageId,
  type TimelineStorageReadId,
  type ValueSnapshot
} from "./timeline-types.js";
import { TimelineRegistry } from "./timeline-registry.js";
import { createTimeline } from "./timeline.js";
import { ValueStateBuilder, type ValueStateWrite } from "./value-state.js";

export function buildTimeline(input: TimelineInput): Timeline {
  return new TimelineBuilder(input).build();
}

class TimelineBuilder {
  readonly #ops: readonly BlockExprOp[];
  readonly #loadResultValuesByVar = new Map<number, JitLoadResultValue>();
  readonly #valueState: ValueStateBuilder;
  readonly #resolver: JitValueResolver;
  readonly #ids = new TimelineRegistry();
  readonly #loadResultRegistry: LoadResultRegistry;
  readonly #valueRefs = new Map<number, JitValue>();
  readonly #expressionsByOp = new Map<number, Map<TimelineExpressionId, JitValue>>();
  readonly #refsByOp = new Map<number, Map<number, JitValue>>();
  readonly #addressesByOp = new Map<number, Map<TimelineStorageId, JitValue>>();
  readonly #storageReadsByOp = new Map<number, Map<TimelineStorageReadId, JitValue>>();
  readonly #writes: SlotWrite[] = [];
  readonly #memoryLoadValues: MemoryLoadValue[] = [];
  readonly #snapshotPoints: ReadonlySet<number>;
  readonly #snapshots = new Map<number, ValueSnapshot>();
  #currentOpIndex = -1;
  #currentSetValue: JitValue | undefined;
  #currentSetValueResolved = false;

  constructor(input: TimelineInput) {
    this.#ops = input.expressions.ops;
    this.#loadResultRegistry = input.loadResultRegistry;
    this.#snapshotPoints = new Set(input.snapshotPoints);
    this.#valueState = new ValueStateBuilder(input.entry);
    this.#resolver = createJitValueResolver({
      readReg32: (reg) => this.#valueState.registers().readReg32(reg),
      readAluFlags: () => this.#valueState.flags().readAluFlags(),
      readValueRef: (value) =>
        value.kind === "var" ? this.#valueRefs.get(value.id) : undefined
    });
  }

  build(): Timeline {
    for (const [opIndex, { op }] of this.#ops.entries()) {
      this.#enterExpressionOp(opIndex);
      this.#recordSnapshotPoint();
      this.#recordInputs(op);
      this.#recordMeaning(op);
      this.#recordWrites(op);
      this.#recordMemoryLoadValue(op);
    }

    return this.#finish();
  }

  #enterExpressionOp(opIndex: number): void {
    this.#currentOpIndex = opIndex;
    this.#currentSetValue = undefined;
    this.#currentSetValueResolved = false;
  }

  #recordInputs(op: IrExprOp): void {
    switch (op.op) {
      case "let32":
        {
          const loadResult = this.#loadResultValueForLet(op);

          if (loadResult !== undefined) {
            this.#recordMemoryLoadExpressionInputs(op.value, loadResult);
          }
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

  #recordMemoryLoadValue(op: IrExprOp): void {
    if (op.op !== "let32") {
      return;
    }

    const loadResult = this.#loadResultValueForLet(op);

    if (loadResult === undefined) {
      return;
    }

    this.#memoryLoadValues.push({
      opIndex: this.#currentOpIndex,
      ref: op.dst,
      value: loadResult
    });
  }

  #finish(): Timeline {
    return createTimeline({
      finalState: this.#valueState.snapshot(),
      opCount: this.#ops.length,
      writes: this.#writes,
      memoryLoadValues: this.#memoryLoadValues,
      snapshots: this.#snapshots,
      storage: {
        catalog: this.#ids,
        ...(this.#expressionsByOp.size === 0 ? {} : { expressionsByOp: this.#expressionsByOp }),
        ...(this.#refsByOp.size === 0 ? {} : { refsByOp: this.#refsByOp }),
        ...(this.#addressesByOp.size === 0 ? {} : { addressesByOp: this.#addressesByOp }),
        ...(this.#storageReadsByOp.size === 0 ? {} : { storageReadsByOp: this.#storageReadsByOp })
      }
    });
  }

  #recordSnapshotPoint(): void {
    const opIndex = this.#currentOpIndex;

    if (!this.#snapshotPoints.has(opIndex)) {
      return;
    }

    this.#snapshots.set(opIndex, this.#valueState.snapshot());
  }

  #recordLetMeaning(op: Extract<IrExprOp, { op: "let32" }>): void {
    const loadResult = this.#loadResultValueForLet(op);
    const value = loadResult ?? this.#valueForExpression(op.value);

    if (loadResult !== undefined && op.value.kind === "source") {
      this.#recordExpressionValue(op.value, loadResult);
    }

    this.#valueRefs.set(op.dst.id, value);
    this.#recordRefValue(op.dst, value);
  }

  #loadResultValueForLet(op: Extract<IrExprOp, { op: "let32" }>): JitLoadResultValue | undefined {
    if (op.value.kind !== "source" || !this.#storageReadIsEffectful(op.value.source)) {
      return undefined;
    }

    const existing = this.#loadResultValuesByVar.get(op.dst.id);

    if (existing !== undefined) {
      return existing;
    }

    const loadResult = this.#loadResultRegistry.createLoadResultValue("i32");

    this.#loadResultValuesByVar.set(op.dst.id, loadResult);
    return loadResult;
  }

  #storageReadIsEffectful(storage: IrStorageExpr): boolean {
    switch (storage.kind) {
      case "mem":
        return true;
      case "operand":
        throw new Error(`unresolved JIT operand storage ${storage.index}`);
      case "reg":
        return false;
    }
  }

  #recordSetWrite(op: Extract<IrExprOp, { op: "set" }>): void {
    const value = this.#currentSetValueResolved
      ? this.#currentSetValue
      : this.#valueForExpression(op.value);

    if (value === undefined) {
      throw new Error(`missing current JIT set value at expression op ${this.#currentOpIndex}`);
    }

    switch (op.target.kind) {
      case "mem":
        return;
      case "reg":
        this.#recordRegisterSlotWrite(jitRegisterSlotForAlias(registerAccess(op.target.reg, op.accessWidth)), value);
        return;
      case "operand":
        throw new Error(`unresolved JIT operand storage ${op.target.index}`);
    }
  }

  #recordRegisterSlotWrite(slot: JitRegisterSlot, value: JitValue): void {
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
      resolved[name] = this.#valueForRef(value);
    }

    return resolved;
  }

  #recordStorageInputs(storage: IrStorageExpr): void {
    switch (storage.kind) {
      case "mem":
        this.#valueForExpression(storage.address);
        return;
      case "operand":
        throw new Error(`unresolved JIT operand storage ${storage.index}`);
      case "reg":
        return;
    }
  }

  #valueForExpression(expression: IrValueExpr): JitValue {
    switch (expression.kind) {
      case "var":
      case "const":
        return this.#valueForRef(expression);
      case "nextEip":
        throw new Error(`unresolved JIT nextEip expression at op ${this.#currentOpIndex}`);
      case "source":
      case "address":
      case "flags.condition":
      case "value.binary":
      case "value.unary":
      case "value.select":
        break;
    }

    const id = this.#ids.registerExpression(expression);
    const values = this.#currentExpressionValues();

    if (values.has(id)) {
      return values.get(id)!;
    }

    const value = this.#resolveExpression(expression);

    values.set(id, value);
    return value;
  }

  #resolveExpression(expression: IrValueExpr): JitValue {
    switch (expression.kind) {
      case "source": {
        this.#recordStorageInputs(expression.source);
        return this.#valueForStorageRead(expression);
      }
      case "address":
        throw new Error(`unresolved JIT address expression at op ${this.#currentOpIndex}`);
      case "value.binary": {
        const a = this.#valueForExpression(expression.a);
        const b = this.#valueForExpression(expression.b);

        return simplifyValue({
          kind: expression.kind,
          type: expression.type,
          operator: expression.operator,
          a,
          b
        });
      }
      case "value.unary": {
        const value = this.#valueForExpression(expression.value);

        return simplifyValue({
          kind: expression.kind,
          type: expression.type,
          operator: expression.operator,
          value
        });
      }
      case "value.select": {
        const condition = this.#valueForExpression(expression.condition);
        const whenTrue = this.#valueForExpression(expression.whenTrue);
        const whenFalse = this.#valueForExpression(expression.whenFalse);

        return simplifyValue({
          kind: expression.kind,
          type: expression.type,
          condition,
          whenTrue,
          whenFalse
        });
      }
      case "flags.condition":
        return this.#resolvedValue(this.#resolver.valueForExpression(expression));
      case "var":
      case "const":
      case "nextEip":
        return this.#valueForRef(expression);
    }
  }

  #recordMemoryLoadExpressionInputs(
    expression: IrValueExpr,
    loadResult?: JitLoadResultValue
  ): void {
    switch (expression.kind) {
      case "var":
      case "const":
        this.#valueForRef(expression);
        return;
      case "nextEip":
        throw new Error(`unresolved JIT nextEip expression at op ${this.#currentOpIndex}`);
      case "source":
        this.#recordStorageInputs(expression.source);
        if (loadResult === undefined) {
          this.#valueForStorageRead(expression);
        } else {
          this.#recordStorageReadValue(expression, loadResult);
        }
        return;
      case "address":
        throw new Error(`unresolved JIT address expression at op ${this.#currentOpIndex}`);
      case "value.binary":
        this.#recordMemoryLoadExpressionInputs(expression.a);
        this.#recordMemoryLoadExpressionInputs(expression.b);
        return;
      case "value.unary":
        this.#recordMemoryLoadExpressionInputs(expression.value);
        return;
      case "value.select":
        this.#recordMemoryLoadExpressionInputs(expression.condition);
        this.#recordMemoryLoadExpressionInputs(expression.whenTrue);
        this.#recordMemoryLoadExpressionInputs(expression.whenFalse);
        return;
      case "flags.condition":
        return;
    }
  }

  #valueForRef(ref: ValueRef): JitValue {
    switch (ref.kind) {
      case "const":
        return this.#resolvedValue(this.#resolver.valueForValueRef(ref));
      case "nextEip":
        throw new Error(`unresolved JIT nextEip ref at expression op ${this.#currentOpIndex}`);
      case "var": {
        const values = this.#currentRefValues();

        if (values.has(ref.id)) {
          return values.get(ref.id)!;
        }

        const resolved = this.#valueRefs.get(ref.id);

        if (resolved === undefined) {
          throw new Error(`could not resolve JIT timeline value at expression op ${this.#currentOpIndex}`);
        }

        values.set(ref.id, resolved);
        return resolved;
      }
    }
  }

  #recordExpressionValue(expression: TimelineExpression, value: JitValue): void {
    this.#currentExpressionValues().set(this.#ids.registerExpression(expression), value);
  }

  #recordRefValue(ref: ValueRef, value: JitValue): void {
    if (ref.kind !== "var") {
      return;
    }

    this.#currentRefValues().set(ref.id, value);
  }

  #valueForStorageRead(expression: Extract<IrValueExpr, { kind: "source" }>): JitValue {
    const id = this.#ids.registerStorageRead({
      source: expression.source,
      accessWidth: expression.accessWidth,
      signed: expression.signed === true
    });
    const values = this.#currentStorageReadValues();

    if (values.has(id)) {
      return values.get(id)!;
    }

    const value = this.#resolvedValue(this.#resolver.valueForStorage(
      expression.source,
      expression.accessWidth,
      expression.signed === true
    ));

    values.set(id, value);
    return value;
  }

  #recordStorageReadValue(
    expression: Extract<IrValueExpr, { kind: "source" }>,
    value: JitValue
  ): void {
    const id = this.#ids.registerStorageRead({
      source: expression.source,
      accessWidth: expression.accessWidth,
      signed: expression.signed === true
    });
    const values = this.#currentStorageReadValues();

    if (!values.has(id)) {
      values.set(id, value);
    }
  }

  #recordWrite(slot: JitArchitecturalSlot, value: JitValue): void {
    this.#writes.push({
      opIndex: this.#currentOpIndex,
      slot,
      value
    });
  }

  #resolvedValue(value: JitValue | undefined): JitValue {
    if (value === undefined) {
      throw new Error(`could not resolve JIT timeline value at expression op ${this.#currentOpIndex}`);
    }

    return value;
  }

  #currentExpressionValues(): Map<TimelineExpressionId, JitValue> {
    return this.#currentOpMap(this.#expressionsByOp);
  }

  #currentRefValues(): Map<number, JitValue> {
    return this.#currentOpMap(this.#refsByOp);
  }

  #currentStorageReadValues(): Map<TimelineStorageReadId, JitValue> {
    return this.#currentOpMap(this.#storageReadsByOp);
  }

  #currentOpMap<TId>(
    maps: Map<number, Map<TId, JitValue>>
  ): Map<TId, JitValue> {
    let values = maps.get(this.#currentOpIndex);

    if (values === undefined) {
      values = new Map();
      maps.set(this.#currentOpIndex, values);
    }

    return values;
  }
}

function registerAccess(reg: RegName, accessWidth: OperandWidth): RegisterAlias {
  const alias = registerAlias(reg);

  return alias.width === 32
    ? { ...alias, width: accessWidth }
    : alias;
}
