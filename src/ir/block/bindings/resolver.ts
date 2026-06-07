import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import { exprConst, exprInput } from "#ir/expr/builders.js";
import type { ModRmSelector } from "#ir/block/modrm-selector.js";
import type {
  ExprInputSource,
  ExprRef
} from "#ir/expr/types.js";
import type {
  StorageRef,
  ValueRef
} from "#ir/model/types.js";
import {
  reg32,
  type OperandWidth,
  type RegisterAlias
} from "#x86/types.js";
import {
  registerAlias,
  registerAliasByIndex
} from "#x86/registers.js";

export type StorageBinding =
  | Readonly<{ kind: "reg"; reg: RegisterAlias }>
  | Readonly<{ kind: "dynamicReg"; selector: ModRmSelector; width: OperandWidth }>
  | Readonly<{ kind: "mem"; address: ExprRef; width: OperandWidth }>;

export type ValueBinding = Readonly<{ kind: "value"; value: ExprRef }>;
export type OperandBinding = StorageBinding | ValueBinding;

export type BindingResolverOptions = Readonly<{
  operands?: readonly OperandBinding[];
  value?: (input: ExprInputSource) => ExprRef;
  irValue?: (value: ValueRef) => ExprRef;
}>;

export class BindingResolver {
  readonly #operands: readonly OperandBinding[];
  readonly #value: (input: ExprInputSource) => ExprRef;
  readonly #irValue: ((value: ValueRef) => ExprRef) | undefined;

  constructor(options: BindingResolverOptions = {}) {
    this.#operands = Object.freeze([...(options.operands ?? [])]);
    this.#value = options.value ?? defaultInputValue;
    this.#irValue = options.irValue;
    Object.freeze(this);
  }

  operand(index: number): OperandBinding {
    const binding = this.#operands[index];

    if (binding === undefined) {
      throw new Error(`missing operand binding: ${index}`);
    }

    return binding;
  }

  value(input: ExprInputSource): ExprRef {
    return canonicalizeExpr(this.#value(input));
  }

  storage(source: StorageRef, accessWidth: OperandWidth = 32): StorageBinding {
    switch (source.kind) {
      case "operand": {
        const binding = this.operand(source.index);

        if (binding.kind === "value") {
          throw new Error(`operand ${source.index} is a value binding, not storage`);
        }

        return binding;
      }
      case "reg":
        return regBinding(regAccess(source.reg, accessWidth));
      case "mem":
        return memBinding(this.#resolveValueRef(source.address), accessWidth);
    }
  }

  address(source: StorageRef, accessWidth: OperandWidth = 32): ExprRef {
    const binding = this.storage(source, accessWidth);

    switch (binding.kind) {
      case "mem":
        return binding.address;
      case "reg":
      case "dynamicReg":
        throw new Error(`${binding.kind} binding has no address`);
    }
  }

  #resolveValueRef(value: ValueRef): ExprRef {
    if (value.kind === "const") {
      return exprConst(value.value);
    }

    if (this.#irValue === undefined) {
      throw new Error(`cannot resolve ${value.kind} address without an IR value resolver`);
    }

    return canonicalizeExpr(this.#irValue(value));
  }
}

export function regBinding(reg: RegisterAlias): StorageBinding {
  return Object.freeze({
    kind: "reg",
    reg: freezeRegisterAlias(reg)
  });
}

export function memBinding(address: ExprRef, width: OperandWidth): StorageBinding {
  return Object.freeze({
    kind: "mem",
    address: canonicalizeExpr(address),
    width
  });
}

export function dynamicRegBinding(selector: ModRmSelector, width: OperandWidth): StorageBinding {
  return Object.freeze({
    kind: "dynamicReg",
    selector,
    width
  });
}

export function valueBinding(value: ExprRef): ValueBinding {
  return Object.freeze({
    kind: "value",
    value: canonicalizeExpr(value)
  });
}

function defaultInputValue(input: ExprInputSource): ExprRef {
  return exprInput(input);
}

function regAccess(reg: RegisterAlias["name"], accessWidth: OperandWidth = 32): RegisterAlias {
  const alias = registerAlias(reg);

  if (alias.width !== 32 || accessWidth === 32) {
    return alias;
  }

  const baseIndex = reg32.indexOf(alias.base);
  const narrowed = registerAliasByIndex(accessWidth, baseIndex);

  if (narrowed.base !== alias.base) {
    throw new Error(`${reg} has no ${accessWidth}-bit register alias`);
  }

  return narrowed;
}

function freezeRegisterAlias(alias: RegisterAlias): RegisterAlias {
  return Object.freeze({
    name: alias.name,
    base: alias.base,
    bitOffset: alias.bitOffset,
    width: alias.width
  });
}
