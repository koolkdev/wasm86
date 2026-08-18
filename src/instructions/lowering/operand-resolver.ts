import { assert } from "#common/assert.js";
import type { MemRef, SegmentRef } from "#instructions/semantics/refs.js";
import type { SegmentRegister } from "#core/types.js";
import type { EffectiveAddressComponents, MemAddressSource, OperandBinding } from "./bindings.js";
import { i32, type I32Value } from "#compiler/function/values.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { InstructionState } from "./state/state.js";

export class OperandScope {
  readonly #parent: OperandScope | undefined;
  readonly #addresses = new Map<number, I32Value>();

  constructor(parent?: OperandScope) {
    this.#parent = parent;
  }

  address(index: number): I32Value | undefined {
    return this.#addresses.get(index) ?? this.#parent?.address(index);
  }

  setAddress(index: number, address: I32Value): void {
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

  forScope(scope: OperandScope, access: BoundStateAccess): ScopedOperandResolver {
    return new ScopedOperandResolver(this, this.#state, scope, access);
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

    assert(binding.kind === "segment", `${binding.kind} operand is not a segment register`);
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

// Address construction is lexical: the fixed scope owns its cache, and every
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

  address(index: number): I32Value {
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

  resolveAddress(memory: MemRef): I32Value {
    return this.#segmentLinearAddress(memory.segment, memory.offset);
  }

  operandUsesDynamicGpr(index: number): boolean {
    return this.#owner.operandUsesDynamicGpr(index);
  }

  #bindingAddress(binding: OperandBinding): I32Value {
    assert(binding.kind === "mem", `address of a ${binding.kind} operand binding`);

    switch (binding.address.kind) {
      case "static":
        return this.#effectiveAddress(binding.address.components);
      case "dynamic":
        return this.#dynamicAddress(binding.address);
    }
  }

  #bindingMemoryReference(index: number, binding: OperandBinding): MemRef {
    assert(binding.kind === "mem", `memory reference of a ${binding.kind} operand binding`);
    return {
      segment: binding.segment,
      offset: this.address(index)
    };
  }

  #dynamicAddress(address: Extract<MemAddressSource, { kind: "dynamic" }>): I32Value {
    if (address.baseRegisterIndex === undefined) {
      return address.addend;
    }

    const base = this.#state.gpr.readDynamic(this.#access, address.baseRegisterIndex, 32);

    return base.add(address.addend);
  }

  #effectiveAddress(components: EffectiveAddressComponents): I32Value {
    let address: I32Value | undefined;

    if (components.base !== undefined) {
      address = this.#state.gpr.read(this.#access, components.base);
    }

    if (components.index !== undefined) {
      const index = this.#state.gpr.read(this.#access, components.index);
      const scaled = components.scale === 1 ? index : index.shl(scaleShift[components.scale]);

      address = address === undefined ? scaled : address.add(scaled);
    }

    if (address === undefined) {
      return i32(components.disp);
    }

    return components.disp === 0 ? address : address.add(components.disp);
  }

  #linearAddress(segment: SegmentRegister, offset: I32Value): I32Value {
    // Flat-memory assumption: CS/DS/ES/SS bases are zero; FS/GS may be non-zero.
    if (segment !== "fs" && segment !== "gs") {
      return offset;
    }

    return this.#state.segments.readBase(this.#access, segment).add(offset);
  }

  #segmentLinearAddress(segment: SegmentRef, offset: I32Value): I32Value {
    switch (segment.kind) {
      case "static":
        return this.#linearAddress(segment.reg, offset);
      case "dynamic":
        return this.#state.segments.readDynamicBase(this.#access, segment.index).add(offset);
    }
  }
}

const scaleShift = { 1: 0, 2: 1, 4: 2, 8: 3 } as const;
