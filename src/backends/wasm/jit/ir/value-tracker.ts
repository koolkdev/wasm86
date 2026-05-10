import type { IrBinaryValueOp, IrSelectValueOp, IrUnaryValueOp, ValueRef } from "#x86/ir/model/types.js";
import type { JitIrBlockInstruction, JitIrOp } from "#backends/wasm/jit/ir/types.js";
import {
  jitValueForEffectiveAddress,
  jitValueForStorage,
  jitValueForValue,
  jitValueReadsReg,
  jitValuesEqual,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import {
  jitStorageRegisterAccess,
  type JitRegisterValueMap
} from "#backends/wasm/jit/ir/register-prefix-values.js";
import type { Reg32 } from "#x86/isa/types.js";
import { i32 } from "#x86/state/cpu-state.js";

export class JitValueTracker {
  private readonly locals = new Map<number, JitValue>();

  clear(): void {
    this.locals.clear();
  }

  valueFor(value: ValueRef): JitValue | undefined {
    return jitValueForValue(value, this.locals);
  }

  record(id: number, value: JitValue | undefined): void {
    if (value === undefined) {
      this.locals.delete(id);
    } else {
      this.locals.set(id, value);
    }
  }

  deleteValuesReadingReg(reg: Reg32): void {
    for (const [id, value] of this.locals) {
      if (jitValueReadsReg(value, reg)) {
        this.locals.delete(id);
      }
    }
  }

  recordOp(
    op: JitIrOp,
    instruction: JitIrBlockInstruction,
    registerValues: JitRegisterValueMap = new Map()
  ): boolean {
    switch (op.op) {
      case "get":
        this.record(op.dst.id, op.role === "symbolicRead"
          ? symbolicRegisterReadValue(op, instruction)
          : jitValueForStorage(
            op.source,
            instruction.operands,
            registerValues,
            op.accessWidth ?? 32,
            op.signed === true
          ));
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
        this.record(op.dst.id, this.binaryValue(op));
        return true;
      case "value.unary":
        this.record(op.dst.id, this.unaryValue(op));
        return true;
      case "value.select":
        this.record(op.dst.id, this.selectValue(op));
        return true;
      default:
        return false;
    }
  }

  refFor(value: JitValue): ValueRef | undefined {
    if (value.kind === "const") {
      return { kind: "const", type: value.type, value: value.value };
    }

    for (const [id, localValue] of this.locals) {
      if (jitValuesEqual(localValue, value)) {
        return { kind: "var", id };
      }
    }

    return undefined;
  }

  private binaryValue(op: Extract<JitIrOp, IrBinaryValueOp>): JitValue | undefined {
    const a = this.valueFor(op.a);
    const b = this.valueFor(op.b);

    return a !== undefined && b !== undefined
      ? { kind: op.op, type: op.type, operator: op.operator, a, b }
      : undefined;
  }

  private unaryValue(op: Extract<JitIrOp, IrUnaryValueOp>): JitValue | undefined {
    const value = this.valueFor(op.value);

    return value === undefined ? undefined : { kind: op.op, type: op.type, operator: op.operator, value };
  }

  private selectValue(op: Extract<JitIrOp, IrSelectValueOp>): JitValue | undefined {
    const condition = this.valueFor(op.condition);
    const whenTrue = this.valueFor(op.whenTrue);
    const whenFalse = this.valueFor(op.whenFalse);

    return condition === undefined || whenTrue === undefined || whenFalse === undefined
      ? undefined
      : { kind: op.op, type: op.type, condition, whenTrue, whenFalse };
  }
}

function symbolicRegisterReadValue(
  op: Extract<JitIrOp, { op: "get" }>,
  instruction: JitIrBlockInstruction
): JitValue | undefined {
  const access = jitStorageRegisterAccess(op.source, instruction.operands, op.accessWidth ?? 32);

  return access?.width === 32 && access.bitOffset === 0
    ? { kind: "reg", reg: access.reg }
    : undefined;
}
