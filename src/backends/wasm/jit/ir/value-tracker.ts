import type { IrBinaryValueOp, IrOp, IrSelectValueOp, IrUnaryValueOp, ValueRef } from "#x86/ir/model/types.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { jitProducedValueForEffectfulRead } from "#backends/wasm/jit/ir/produced-values.js";
import {
  jitValueForEffectiveAddress,
  jitValueForStorage,
  jitValueForValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { JitRegisterValueMap } from "#backends/wasm/jit/ir/register-prefix-values.js";
import type { JitIrLocation } from "#backends/wasm/jit/ir/walk.js";
import { i32 } from "#x86/state/cpu-state.js";

export type JitValueTrackerRecordOptions = Readonly<{
  location?: JitIrLocation;
}>;

export class JitValueTracker {
  #locals = new Map<number, JitValue>();

  clear(): void {
    this.#locals.clear();
  }

  valueFor(value: ValueRef): JitValue | undefined {
    return jitValueForValue(value, this.#locals);
  }

  requiredValueFor(value: ValueRef): JitValue {
    const jitValue = this.valueFor(value);

    if (jitValue === undefined) {
      throw new Error(`could not resolve ${valueRefLabel(value)} as a JIT value`);
    }

    return jitValue;
  }

  inputRecordFor(inputs: Readonly<Record<string, ValueRef>>): Readonly<Record<string, JitValue>> {
    const resolved: Record<string, JitValue> = {};

    for (const [name, value] of Object.entries(inputs)) {
      resolved[name] = this.requiredValueFor(value);
    }

    return resolved;
  }

  record(id: number, value: JitValue | undefined): void {
    if (value === undefined) {
      this.#locals.delete(id);
    } else {
      this.#locals.set(id, value);
    }
  }

  recordOp(
    op: IrOp,
    instruction: JitIrBlockInstruction,
    registerValues: JitRegisterValueMap = new Map(),
    options: JitIrLocation | JitValueTrackerRecordOptions = {}
  ): boolean {
    const recordOptions = normalizeRecordOptions(options);

    switch (op.op) {
      case "get":
        this.record(op.dst.id, this.#getValue(op, instruction, registerValues, recordOptions));
        return true;
      case "address":
        this.record(
          op.dst.id,
          jitValueForEffectiveAddress(op.operand, instruction.operands, registerValues)
        );
        return true;
      case "value.const":
        this.record(op.dst.id, { kind: "const", type: op.type, value: i32(op.value) });
        return true;
      case "value.binary":
        this.record(op.dst.id, this.#binaryValue(op));
        return true;
      case "value.unary":
        this.record(op.dst.id, this.#unaryValue(op));
        return true;
      case "value.select":
        this.record(op.dst.id, this.#selectValue(op));
        return true;
      default:
        return false;
    }
  }

  #binaryValue(op: Extract<IrOp, IrBinaryValueOp>): JitValue | undefined {
    const a = this.valueFor(op.a);
    const b = this.valueFor(op.b);

    return a !== undefined && b !== undefined
      ? { kind: op.op, type: op.type, operator: op.operator, a, b }
      : undefined;
  }

  #unaryValue(op: Extract<IrOp, IrUnaryValueOp>): JitValue | undefined {
    const value = this.valueFor(op.value);

    return value === undefined ? undefined : { kind: op.op, type: op.type, operator: op.operator, value };
  }

  #selectValue(op: Extract<IrOp, IrSelectValueOp>): JitValue | undefined {
    const condition = this.valueFor(op.condition);
    const whenTrue = this.valueFor(op.whenTrue);
    const whenFalse = this.valueFor(op.whenFalse);

    return condition === undefined || whenTrue === undefined || whenFalse === undefined
      ? undefined
      : { kind: op.op, type: op.type, condition, whenTrue, whenFalse };
  }

  #getValue(
    op: Extract<IrOp, { op: "get" }>,
    instruction: JitIrBlockInstruction,
    registerValues: JitRegisterValueMap,
    options: JitValueTrackerRecordOptions
  ): JitValue | undefined {
    return (options.location === undefined
      ? undefined
      : jitProducedValueForEffectfulRead(instruction, options.location, op)) ??
      jitValueForStorage(
        op.source,
        instruction.operands,
        registerValues,
        op.accessWidth ?? 32,
        op.signed === true
      );
  }
}

function normalizeRecordOptions(
  options: JitIrLocation | JitValueTrackerRecordOptions
): JitValueTrackerRecordOptions {
  return "instructionIndex" in options
    ? { location: options }
    : options;
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
