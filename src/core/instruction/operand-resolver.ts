import { assert } from "#common/assert.js";
import type { MemRef, SegmentRef } from "#core/semantics/refs.js";
import type { SegmentRegister } from "#core/types.js";
import type {
  EffectiveAddressComponents,
  MemAddressSource,
  OperandBinding
} from "./bindings.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { InstructionState } from "./state/state.js";

export class OperandScope {
  readonly #parent: OperandScope | undefined;
  readonly #addresses = new Map<number, ValueId>();

  constructor(parent?: OperandScope) {
    this.#parent = parent;
  }

  address(index: number): ValueId | undefined {
    return this.#addresses.get(index) ?? this.#parent?.address(index);
  }

  setAddress(index: number, address: ValueId): void {
    this.#addresses.set(index, address);
  }

  clear(): void {
    this.#addresses.clear();
  }
}

export class OperandResolver {
  readonly #state: InstructionState;
  #bindings: readonly OperandBinding[] = [];

  constructor(state: InstructionState) {
    this.#state = state;
  }

  bind(
    scope: OperandScope,
    access: BoundStateAccess
  ): ScopedOperandResolver {
    return new ScopedOperandResolver(
      this,
      this.#state,
      scope,
      access
    );
  }

  beginInstruction(bindings: readonly OperandBinding[]): void {
    this.#bindings = bindings;
  }

  endInstruction(): void {
    this.#bindings = [];
  }

  currentBindings(): readonly OperandBinding[] {
    return this.#bindings;
  }

  binding(index: number): OperandBinding {
    const binding = this.#bindings[index];

    assert(binding !== undefined, `missing operand binding for operand ${index}`);
    return binding;
  }

  isMemory(index: number): boolean {
    return this.binding(index).kind === "mem";
  }

  segment(index: number): SegmentRef {
    const binding = this.binding(index);

    assert(
      binding.kind === "segment",
      `${binding.kind} operand is not a segment register`
    );
    return binding.selection;
  }

  operandUsesDynamicGpr(index: number): boolean {
    const binding = this.binding(index);

    return binding.kind === "reg"
      ? binding.selection.kind === "dynamic"
      : binding.kind === "mem" &&
          binding.address.kind === "dynamic" &&
          binding.address.baseRegisterIndex !== undefined;
  }
}

// Address realization is lexical: the fixed scope owns its cache, and every
// architectural read uses the state access bound to the same region.
export class ScopedOperandResolver {
  readonly #owner: OperandResolver;
  readonly #state: InstructionState;
  readonly #scope: OperandScope;
  readonly #access: BoundStateAccess;

  constructor(
    owner: OperandResolver,
    state: InstructionState,
    scope: OperandScope,
    access: BoundStateAccess
  ) {
    this.#owner = owner;
    this.#state = state;
    this.#scope = scope;
    this.#access = access;
  }

  binding(index: number): OperandBinding {
    return this.#owner.binding(index);
  }

  isMemory(index: number): boolean {
    return this.#owner.isMemory(index);
  }

  segment(index: number): SegmentRef {
    return this.#owner.segment(index);
  }

  address(index: number): ValueId {
    const scope = this.#scope;
    const cached = scope.address(index);

    if (cached !== undefined) {
      return cached;
    }

    const binding = this.binding(index);
    const address = this.#bindingAddress(binding);

    scope.setAddress(index, address);
    return address;
  }

  memoryReference(index: number): MemRef {
    const binding = this.binding(index);
    return this.#bindingMemoryReference(index, binding);
  }

  resolveAddress(memory: MemRef): ValueId {
    return this.#segmentLinearAddress(memory.segment, memory.offset);
  }

  operandUsesDynamicGpr(index: number): boolean {
    return this.#owner.operandUsesDynamicGpr(index);
  }

  #bindingAddress(binding: OperandBinding): ValueId {
    assert(
      binding.kind === "mem",
      `address of a ${binding.kind} operand binding`
    );

    switch (binding.address.kind) {
      case "static":
        return this.#effectiveAddress(binding.address.components);
      case "dynamic":
        return this.#dynamicAddress(binding.address);
    }
  }

  #bindingMemoryReference(index: number, binding: OperandBinding): MemRef {
    assert(
      binding.kind === "mem",
      `memory reference of a ${binding.kind} operand binding`
    );
    return {
      segment: binding.segment,
      offset: this.address(index)
    };
  }

  #dynamicAddress(
    address: Extract<MemAddressSource, { kind: "dynamic" }>
  ): ValueId {
    if (address.baseRegisterIndex === undefined) {
      return address.addend;
    }

    const base = this.#state.gpr.readDynamic(
      this.#access,
      address.baseRegisterIndex,
      32
    );

    return this.#access.values.binary(
      "add",
      base,
      address.addend
    );
  }

  #effectiveAddress(components: EffectiveAddressComponents): ValueId {
    let address: ValueId | undefined;

    if (components.base !== undefined) {
      address = this.#state.gpr.read(this.#access, components.base);
    }

    if (components.index !== undefined) {
      const index = this.#state.gpr.read(this.#access, components.index);
      const scaled = components.scale === 1
        ? index
        : this.#access.values.binary(
            "shl",
            index,
            this.#access.values.const(scaleShift[components.scale])
          );

      address = address === undefined
        ? scaled
        : this.#access.values.binary("add", address, scaled);
    }

    if (address === undefined) {
      return this.#access.values.const(components.disp);
    }

    return components.disp === 0
      ? address
      : this.#access.values.binary(
          "add",
          address,
          this.#access.values.const(components.disp)
        );
  }

  #linearAddress(segment: SegmentRegister, offset: ValueId): ValueId {
    // Flat-memory assumption: CS/DS/ES/SS bases are zero; FS/GS may be non-zero.
    if (segment !== "fs" && segment !== "gs") {
      return offset;
    }

    return this.#access.values.binary(
      "add",
      this.#state.segments.readBase(this.#access, segment),
      offset
    );
  }

  #segmentLinearAddress(segment: SegmentRef, offset: ValueId): ValueId {
    switch (segment.kind) {
      case "static":
        return this.#linearAddress(segment.reg, offset);
      case "dynamic":
        return this.#access.values.binary(
          "add",
          this.#state.segments.readDynamicBase(this.#access, segment.index),
          offset
        );
    }
  }
}

const scaleShift = { 1: 0, 2: 1, 4: 2, 8: 3 } as const;
