import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import { exprDependencies, type ExprDependency } from "#ir/expr/dependencies.js";
import { exprConst, exprInput } from "#ir/expr/builders.js";
import type {
  ExprInputSource,
  ExprRef,
  ExprUse
} from "#ir/expr/types.js";
import { exactUse } from "#ir/expr/uses.js";
import type { FlagName } from "#ir/model/flags.js";
import type {
  StorageRef,
  ValueRef
} from "#ir/model/types.js";
import {
  reg32,
  widthMask,
  type OperandWidth,
  type Reg32,
  type RegisterAlias
} from "#x86/types.js";
import {
  registerAlias,
  registerAliasByIndex,
  registerAliasesByWidth
} from "#x86/registers.js";

export type StorageBinding =
  | Readonly<{ kind: "reg"; reg: RegisterAlias }>
  | Readonly<{ kind: "dynamicReg"; index: ExprRef; width: OperandWidth }>
  | Readonly<{ kind: "mem"; address: ExprRef; width: OperandWidth }>;

export type ValueBinding = Readonly<{ kind: "value"; value: ExprRef }>;
export type OperandBinding = StorageBinding | ValueBinding;

export type BindingMemoryAccess = Readonly<{ kind: "memory" }>;
export type BindingDependency = ExprDependency | BindingMemoryAccess;
export type BindingClobber =
  | Readonly<{ kind: "reg"; reg: Reg32; mask: number }>
  | BindingMemoryAccess;

export type BindingDependencies = readonly BindingDependency[];
export type BindingClobbers = readonly BindingClobber[];

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

  readDeps(source: OperandBinding, use: ExprUse = exactUse()): BindingDependencies {
    return dependencyList(this.#accessesFor(source, "read", use));
  }

  writeDeps(target: StorageBinding): BindingDependencies {
    return dependencyList(this.#accessesFor(target, "address", exactUse()));
  }

  clobbers(target: StorageBinding, use: ExprUse = exactUse()): BindingClobbers {
    return clobberList(this.#accessesFor(target, "clobber", use));
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

  #accessesFor(
    binding: OperandBinding,
    mode: BindingAccessMode,
    use: ExprUse
  ): AccessSet {
    const accesses = createAccessSet();

    switch (binding.kind) {
      case "value":
        if (mode !== "read") {
          throw new Error("value bindings do not have address dependencies or clobbers");
        }
        addExprDependencies(binding.value, use, accesses);
        break;
      case "reg":
        if (mode !== "address") {
          addRegisterAliasAccess(binding.reg, use, accesses);
        }
        break;
      case "mem":
        if (mode !== "clobber") {
          addExprDependencies(binding.address, exactUse(), accesses);
        }
        if (mode !== "address") {
          accesses.memory = true;
        }
        break;
      case "dynamicReg":
        if (mode !== "clobber") {
          addExprDependencies(binding.index, exactUse(), accesses);
        }
        if (mode !== "address") {
          addDynamicRegisterAccesses(binding.width, use, accesses);
        }
        break;
    }

    return accesses;
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

export function dynamicRegBinding(index: ExprRef, width: OperandWidth): StorageBinding {
  return Object.freeze({
    kind: "dynamicReg",
    index: canonicalizeExpr(index),
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

type BindingAccessMode = "read" | "address" | "clobber";

type AccessSet = {
  regs: Map<Reg32, number>;
  flags: Map<FlagName, true>;
  defs: Extract<ExprDependency, Readonly<{ kind: "def" }>>[];
  memory: boolean;
};

function createAccessSet(): AccessSet {
  return {
    regs: new Map(),
    flags: new Map(),
    defs: [],
    memory: false
  };
}

function addExprDependencies(expr: ExprRef, use: ExprUse, accesses: AccessSet): void {
  for (const dep of exprDependencies(expr, use)) {
    switch (dep.kind) {
      case "reg":
        addRegisterAccess(dep.reg, dep.mask, accesses);
        break;
      case "flag":
        accesses.flags.set(dep.flag, true);
        break;
      case "def":
        accesses.defs.push(dep);
        break;
    }
  }
}

function addDynamicRegisterAccesses(width: OperandWidth, use: ExprUse, accesses: AccessSet): void {
  for (const alias of registerAliasesByWidth[width]) {
    addRegisterAliasAccess(alias, use, accesses);
  }
}

function addRegisterAliasAccess(alias: RegisterAlias, use: ExprUse, accesses: AccessSet): void {
  const mask = registerAliasUseMask(alias, use);

  if (mask === 0) {
    return;
  }

  addRegisterAccess(alias.base, mask, accesses);
}

function addRegisterAccess(reg: Reg32, mask: number, accesses: AccessSet): void {
  const cleanMask = mask >>> 0;

  if (cleanMask === 0) {
    return;
  }

  accesses.regs.set(reg, ((accesses.regs.get(reg) ?? 0) | cleanMask) >>> 0);
}

function dependencyList(accesses: AccessSet): BindingDependencies {
  const result: BindingDependency[] = [];

  for (const reg of reg32) {
    const mask = accesses.regs.get(reg);

    if (mask !== undefined) {
      result.push(Object.freeze({ kind: "reg", reg, mask }));
    }
  }

  for (const flag of accesses.flags.keys()) {
    result.push(Object.freeze({ kind: "flag", flag }));
  }

  for (const dep of accesses.defs) {
    result.push(Object.freeze({ kind: "def", id: dep.id, use: dep.use }));
  }

  if (accesses.memory) {
    result.push(memoryAccess());
  }

  return Object.freeze(result);
}

function clobberList(accesses: AccessSet): BindingClobbers {
  const result: BindingClobber[] = [];

  for (const reg of reg32) {
    const mask = accesses.regs.get(reg);

    if (mask !== undefined) {
      result.push(Object.freeze({ kind: "reg", reg, mask }));
    }
  }

  if (accesses.memory) {
    result.push(memoryAccess());
  }

  return Object.freeze(result);
}

function memoryAccess(): BindingMemoryAccess {
  return Object.freeze({ kind: "memory" });
}

function registerAliasUseMask(alias: RegisterAlias, use: ExprUse): number {
  const aliasMask = useMaskForWidth(use, alias.width);

  return (aliasMask << alias.bitOffset) >>> 0;
}

function useMaskForWidth(use: ExprUse, width: OperandWidth): number {
  switch (use.kind) {
    case "exact":
    case "full32":
      return widthMask(width);
    case "bits":
      return (use.mask & widthMask(width)) >>> 0;
  }
}

function freezeRegisterAlias(alias: RegisterAlias): RegisterAlias {
  return Object.freeze({
    name: alias.name,
    base: alias.base,
    bitOffset: alias.bitOffset,
    width: alias.width
  });
}
