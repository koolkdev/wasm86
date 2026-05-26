import {
  BindingResolver,
  type StorageBinding
} from "#x86/block/bindings/resolver.js";
import type { ExprRef } from "#x86/expr/types.js";
import type {
  StorageRef,
  ValueRef
} from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { DynamicRegisterWalkOps } from "./dynamic-register-ops.js";
import type { MemoryWalkOps } from "./memory-ops.js";
import type { RegisterWalkState } from "./registers.js";
import {
  resolveStorageRead,
  resolveStorageWrite
} from "./storage.js";

export class StorageWalkOps {
  readonly #resolver: BindingResolver;
  readonly #registers: RegisterWalkState;
  readonly #dynamic: DynamicRegisterWalkOps;
  readonly #memory: MemoryWalkOps;
  readonly #value: (value: ValueRef) => ExprRef;

  constructor(input: Readonly<{
    resolver: BindingResolver;
    registers: RegisterWalkState;
    dynamic: DynamicRegisterWalkOps;
    memory: MemoryWalkOps;
    value: (value: ValueRef) => ExprRef;
  }>) {
    this.#resolver = input.resolver;
    this.#registers = input.registers;
    this.#dynamic = input.dynamic;
    this.#memory = input.memory;
    this.#value = input.value;
  }

  address(source: StorageRef): ExprRef {
    return this.#resolver.address(source);
  }

  read(source: StorageRef, width: OperandWidth): ExprRef {
    const read = resolveStorageRead(
      this.#resolver,
      source,
      width,
      this.#value
    );

    return read.kind === "value"
      ? read.value
      : this.#readBinding(read.binding);
  }

  write(target: StorageRef, value: ExprRef, width: OperandWidth): void {
    const binding = resolveStorageWrite(
      this.#resolver,
      target,
      width,
      this.#value
    );

    this.#writeBinding(binding, value);
  }

  #readBinding(binding: StorageBinding): ExprRef {
    switch (binding.kind) {
      case "reg":
        return this.#registers.readAlias(binding.reg, "storageRead");
      case "dynamicReg":
        return this.#dynamic.load(binding.index, binding.width);
      case "mem":
        return this.#memory.load(binding.address, binding.width);
    }
  }

  #writeBinding(binding: StorageBinding, value: ExprRef): void {
    switch (binding.kind) {
      case "reg":
        this.#registers.writeAlias(binding.reg, value);
        return;
      case "dynamicReg":
        this.#dynamic.store(binding.index, value, binding.width);
        return;
      case "mem":
        this.#memory.store(binding.address, value, binding.width);
        return;
    }
  }
}
