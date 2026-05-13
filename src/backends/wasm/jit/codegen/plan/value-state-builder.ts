import type {
  IrBinaryValueOp,
  ConditionCode,
  IrOp,
  IrSelectValueOp,
  IrUnaryValueOp,
  ValueRef
} from "#x86/ir/model/types.js";
import type {
  IrExprOp,
  IrStorageExpr
} from "#backends/wasm/codegen/expressions.js";
import { i32 } from "#x86/state/cpu-state.js";
import { reg32, type OperandWidth, type Reg32 } from "#x86/isa/types.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { jitProducedValueForEffectfulRead } from "#backends/wasm/jit/ir/produced-values.js";
import {
  jitValueForEffectiveAddress,
  jitValueForStorage,
  jitValueForValue,
  type JitArchitecturalSlot,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import {
  jitStorageRegisterAccess,
  type JitRegisterValueMap
} from "#backends/wasm/jit/ir/register-prefix-values.js";
import type { JitIrLocation } from "#backends/wasm/jit/ir/walk.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import {
  createJitValueState,
  createJitValueStateFromSnapshot,
  type JitValueState,
  type JitValueStateSnapshot
} from "#backends/wasm/jit/state/value-state.js";
import {
  jitFlagSetProducerValue,
  jitFlagSetWrittenMask
} from "./flag-values.js";
import { jitStorageRegisterAlias } from "./operand-analysis.js";

export type JitValueStateBuilderWrite = Readonly<{
  slot: JitArchitecturalSlot;
  value: JitValue;
}>;

export type JitSourceValueMapRecordOptions = Readonly<{
  location?: JitIrLocation;
}>;

export class JitValueStateBuilder {
  readonly #valueState: JitValueState;

  constructor(snapshot?: JitValueStateSnapshot) {
    this.#valueState = snapshot === undefined
      ? createJitValueState()
      : createJitValueStateFromSnapshot(snapshot);
  }

  snapshot(): JitValueStateSnapshot {
    return this.#valueState.snapshot();
  }

  readReg32(reg: Reg32): JitValue {
    return this.#valueState.regs.readReg32(reg);
  }

  readAluFlags(): JitValue {
    return this.#valueState.flags.readAluFlags();
  }

  condition(cc: ConditionCode): JitValue {
    return this.#valueState.flags.condition(cc);
  }

  currentRegisterValues(): JitRegisterValueMap {
    return new Map(reg32.map((reg) => [reg, this.#valueState.regs.readReg32(reg)]));
  }

  recordSourceSet(
    op: Extract<IrOp, { op: "set" }>,
    instruction: JitIrBlockInstruction,
    value: JitValue | undefined
  ): JitValueStateBuilderWrite | undefined {
    const access = jitStorageRegisterAccess(op.target, instruction.operands, op.accessWidth ?? 32);

    if (access === undefined) {
      return undefined;
    }

    if (value === undefined) {
      throw new Error("could not resolve JIT boundary-state register write");
    }

    return this.#writeReg(access.reg, access.bitOffset, access.width, value);
  }

  recordExpressionSet(
    target: IrStorageExpr,
    operands: readonly JitOperandBinding[],
    accessWidth: OperandWidth,
    value: JitValue
  ): JitValueStateBuilderWrite | undefined {
    const alias = jitStorageRegisterAlias({ operands }, target, accessWidth);

    if (alias === undefined) {
      return undefined;
    }

    return this.#writeReg(alias.base, alias.bitOffset, alias.width, value);
  }

  recordFlagSet(
    op: Extract<IrOp | IrExprOp, { op: "flags.set" }>,
    resolveInputs: () => Readonly<Record<string, JitValue>>
  ): JitValueStateBuilderWrite | undefined {
    const mask = jitFlagSetWrittenMask(op);

    if (mask === 0) {
      return undefined;
    }

    const producer = jitFlagSetProducerValue(op, resolveInputs());

    this.#valueState.flags.writeFlagBits(mask, producer);
    return {
      slot: { kind: "aluFlags" },
      value: this.#valueState.flags.readAluFlags()
    };
  }

  #writeReg(
    reg: Reg32,
    bitOffset: number,
    width: OperandWidth,
    value: JitValue
  ): JitValueStateBuilderWrite {
    if (width === 32 && bitOffset === 0) {
      this.#valueState.regs.writeReg32(reg, value);
    } else {
      this.#valueState.regs.writeRegPart(reg, bitOffset, width, value);
    }

    return {
      slot: { kind: "reg32", reg },
      value: this.#valueState.regs.readReg32(reg)
    };
  }
}

export class JitSourceValueMap {
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
    options: JitIrLocation | JitSourceValueMapRecordOptions = {}
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
    options: JitSourceValueMapRecordOptions
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
  options: JitIrLocation | JitSourceValueMapRecordOptions
): JitSourceValueMapRecordOptions {
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
