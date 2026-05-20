import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import {
  jitExtractBits,
  jitFlagConditionValue,
  jitInputReg32Value
} from "#backends/wasm/jit/ir/values/builders.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { OperandRef, StorageRef, ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth, RegisterAlias, Reg32 } from "#x86/isa/types.js";

export type JitValueResolverReadReg32 = (reg: Reg32) => JitValue;
export type JitValueResolverReadAluFlags = () => JitValue | undefined;
export type JitValueResolverReadValueRef = (value: ValueRef) => JitValue | undefined;

export type JitValueResolverOptions = Readonly<{
  operands: readonly JitOperandBinding[];
  readReg32?: JitValueResolverReadReg32;
  readAluFlags?: JitValueResolverReadAluFlags;
  readValueRef?: JitValueResolverReadValueRef;
}>;

export class JitValueResolver {
  readonly #operands: readonly JitOperandBinding[];
  readonly #readReg32: JitValueResolverReadReg32;
  readonly #readAluFlags: JitValueResolverReadAluFlags | undefined;
  readonly #readValueRef: JitValueResolverReadValueRef | undefined;

  constructor(options: JitValueResolverOptions) {
    this.#operands = options.operands;
    this.#readReg32 = options.readReg32 ?? jitInputReg32Value;
    this.#readAluFlags = options.readAluFlags;
    this.#readValueRef = options.readValueRef;
  }

  valueForStorage(
    storage: StorageRef | IrStorageExpr,
    accessWidth: OperandWidth = 32,
    signed = false
  ): JitValue | undefined {
    const value = this.#valueForStorageUnsigned(storage, accessWidth);

    return value === undefined || !signed || accessWidth >= 32
      ? value
      : signExtendJitValue(value, accessWidth as 8 | 16);
  }

  valueForRegisterAlias(alias: RegisterAlias, signed = false): JitValue {
    const value = this.#valueForRegisterAccess({
      reg: alias.base,
      width: alias.width,
      bitOffset: alias.bitOffset
    });

    return signed && alias.width < 32
      ? signExtendJitValue(value, alias.width as 8 | 16)
      : value;
  }

  valueForEffectiveAddress(operand: OperandRef): JitValue | undefined {
    const binding = this.#operands[operand.index];

    if (binding?.kind !== "static.mem") {
      return undefined;
    }

    const terms: JitValue[] = [];

    if (binding.ea.base !== undefined) {
      terms.push(this.#fullRegValue(binding.ea.base));
    }

    if (binding.ea.index !== undefined) {
      terms.push(scaleJitValue(this.#fullRegValue(binding.ea.index), binding.ea.scale));
    }

    if (binding.ea.disp !== 0 || terms.length === 0) {
      terms.push(c32(binding.ea.disp));
    }

    return terms.reduce((a, b) => addJitValues(a, b));
  }

  valueForValueRef(value: ValueRef): JitValue | undefined {
    switch (value.kind) {
      case "var":
        return this.#readValueRef?.(value);
      case "const":
        return c32(value.value);
      case "nextEip":
        return undefined;
    }
  }

  valueForExpression(expression: IrValueExpr): JitValue | undefined {
    return this.#valueForExpressionUnrecorded(expression);
  }

  #valueForStorageUnsigned(
    storage: StorageRef | IrStorageExpr,
    accessWidth: OperandWidth
  ): JitValue | undefined {
    switch (storage.kind) {
      case "reg":
        return this.#valueForRegisterAccess({ reg: storage.reg, width: accessWidth, bitOffset: 0 });
      case "operand":
        return this.#valueForOperandBinding(this.#operands[storage.index], accessWidth);
      case "mem":
        return undefined;
    }
  }

  #valueForOperandBinding(
    binding: JitOperandBinding | undefined,
    accessWidth: OperandWidth
  ): JitValue | undefined {
    switch (binding?.kind) {
      case "static.reg":
        return this.#valueForRegisterAccess({
          reg: binding.alias.base,
          width: binding.alias.width,
          bitOffset: binding.alias.bitOffset
        });
      case "static.imm32":
        return simplifyValue(jitExtractBits(c32(binding.value), 0, accessWidth));
      case "static.relTarget":
        return simplifyValue(jitExtractBits(c32(binding.target), 0, accessWidth));
      case "static.mem":
      case undefined:
        return undefined;
    }
  }

  #valueForRegisterAccess(
    access: Readonly<{
      reg: Reg32;
      width: OperandWidth;
      bitOffset: RegisterAlias["bitOffset"];
    }>
  ): JitValue {
    const full = this.#fullRegValue(access.reg);

    return access.width === 32 && access.bitOffset === 0
      ? full
      : simplifyValue(jitExtractBits(full, access.bitOffset, access.width));
  }

  #fullRegValue(reg: Reg32): JitValue {
    return simplifyValue(this.#readReg32(reg));
  }

  #valueForExpressionUnrecorded(expression: IrValueExpr): JitValue | undefined {
    switch (expression.kind) {
      case "var":
      case "const":
      case "nextEip":
        return this.valueForValueRef(expression);
      case "source":
        return this.valueForStorage(expression.source, expression.accessWidth, expression.signed === true);
      case "address":
        return this.valueForEffectiveAddress(expression.operand);
      case "value.binary": {
        const a = this.#valueForExpressionUnrecorded(expression.a);
        const b = this.#valueForExpressionUnrecorded(expression.b);

        return a === undefined || b === undefined
          ? undefined
          : simplifyValue({ kind: expression.kind, type: expression.type, operator: expression.operator, a, b });
      }
      case "value.unary": {
        const value = this.#valueForExpressionUnrecorded(expression.value);

        return value === undefined
          ? undefined
          : simplifyValue({ kind: expression.kind, type: expression.type, operator: expression.operator, value });
      }
      case "value.select": {
        const condition = this.#valueForExpressionUnrecorded(expression.condition);
        const whenTrue = this.#valueForExpressionUnrecorded(expression.whenTrue);
        const whenFalse = this.#valueForExpressionUnrecorded(expression.whenFalse);

        return condition === undefined || whenTrue === undefined || whenFalse === undefined
          ? undefined
          : simplifyValue({
              kind: expression.kind,
              type: expression.type,
              condition,
              whenTrue,
              whenFalse
            });
      }
      case "flags.condition": {
        const flags = this.#readAluFlags?.();

        return flags === undefined
          ? undefined
          : simplifyValue(jitFlagConditionValue(flags, expression.cc));
      }
    }
  }
}

export function createJitValueResolver(options: JitValueResolverOptions): JitValueResolver {
  return new JitValueResolver(options);
}

function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value: i32(value) };
}

function scaleJitValue(value: JitValue, scale: 1 | 2 | 4 | 8): JitValue {
  switch (scale) {
    case 1:
      return value;
    case 2:
      return shlJitValue(value, 1);
    case 4:
      return shlJitValue(value, 2);
    case 8:
      return shlJitValue(value, 3);
  }
}

function addJitValues(a: JitValue, b: JitValue): JitValue {
  return simplifyValue({ kind: "value.binary", type: "i32", operator: "add", a, b });
}

function shlJitValue(a: JitValue, shift: 1 | 2 | 3): JitValue {
  return simplifyValue({
    kind: "value.binary",
    type: "i32",
    operator: "shl",
    a,
    b: c32(shift)
  });
}

function signExtendJitValue(value: JitValue, width: 8 | 16): JitValue {
  return simplifyValue({
    kind: "value.unary",
    type: "i32",
    operator: width === 8 ? "extend8_s" : "extend16_s",
    value
  });
}
