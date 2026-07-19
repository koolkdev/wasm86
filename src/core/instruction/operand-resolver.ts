import { assert } from "#common/assert.js";
import type { MemRef, SegmentRef } from "#core/semantics/refs.js";
import type { SegmentRegister } from "#core/types.js";
import type {
  EffectiveAddressTerms,
  MemDynamicOperandBinding,
  MemSegmentBinding,
  OperandBinding,
  RegDynamicOperandBinding
} from "./bindings.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
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
  readonly #values: ValueTable;
  readonly #state: InstructionState;
  #bindings: readonly OperandBinding[] = [];

  constructor(values: ValueTable, state: InstructionState) {
    this.#values = values;
    this.#state = state;
  }

  bind(
    scope: OperandScope,
    access: BoundStateAccess
  ): ScopedOperandResolver {
    return new ScopedOperandResolver(
      this,
      this.#values,
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
    const binding = this.binding(index);

    return binding.kind === "mem" ||
      binding.kind === "memStatic" ||
      binding.kind === "memDynamic";
  }

  segment(index: number): SegmentRef {
    const binding = this.binding(index);

    switch (binding.kind) {
      case "segment":
        return { kind: "static", reg: binding.reg };
      case "segmentDynamic":
        return {
          kind: "dynamic",
          index: this.#values.external(binding.index)
        };
      default:
        assert(false, `${binding.kind} operand is not a segment register`);
    }
  }

  dynamicGprIndex(binding: RegDynamicOperandBinding): ValueId {
    return this.#values.external(binding.index);
  }

  operandUsesDynamicGpr(index: number): boolean {
    const binding = this.binding(index);

    return binding.kind === "regDynamic" || binding.kind === "memDynamic";
  }
}

// Address realization is lexical: the fixed scope owns its cache, and every
// architectural read uses the state access bound to the same region.
export class ScopedOperandResolver {
  readonly #owner: OperandResolver;
  readonly #values: ValueTable;
  readonly #state: InstructionState;
  readonly #scope: OperandScope;
  readonly #access: BoundStateAccess;

  constructor(
    owner: OperandResolver,
    values: ValueTable,
    state: InstructionState,
    scope: OperandScope,
    access: BoundStateAccess
  ) {
    this.#owner = owner;
    this.#values = values;
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

  dynamicGprIndex(binding: RegDynamicOperandBinding): ValueId {
    return this.#owner.dynamicGprIndex(binding);
  }

  operandUsesDynamicGpr(index: number): boolean {
    return this.#owner.operandUsesDynamicGpr(index);
  }

  #bindingAddress(binding: OperandBinding): ValueId {
    assert(
      binding.kind === "mem" || binding.kind === "memStatic" || binding.kind === "memDynamic",
      `address of a ${binding.kind} operand binding`
    );

    switch (binding.kind) {
      case "mem":
        return this.#effectiveAddress(binding.address);
      case "memStatic":
        return this.#values.external(binding.address);
      case "memDynamic":
        return this.#dynamicAddress(binding);
    }
  }

  #bindingMemoryReference(index: number, binding: OperandBinding): MemRef {
    assert(
      binding.kind === "mem" || binding.kind === "memStatic" || binding.kind === "memDynamic",
      `memory reference of a ${binding.kind} operand binding`
    );

    switch (binding.kind) {
      case "mem":
      case "memStatic":
      case "memDynamic":
        return this.#memReference(binding.segment, this.address(index));
    }
  }

  #dynamicAddress(binding: MemDynamicOperandBinding): ValueId {
    const base = this.#state.gpr.readDynamic(
      this.#access,
      this.#values.external(binding.base),
      32
    );

    return this.#values.binary("add", base, this.#values.external(binding.offset));
  }

  #effectiveAddress(ea: EffectiveAddressTerms): ValueId {
    let address: ValueId | undefined;

    if (ea.base !== undefined) {
      address = this.#state.gpr.read(this.#access, ea.base);
    }

    if (ea.index !== undefined) {
      const index = this.#state.gpr.read(this.#access, ea.index);
      const scaled = ea.scale === 1
        ? index
        : this.#values.binary("shl", index, this.#values.const(scaleShift[ea.scale]));

      address = address === undefined ? scaled : this.#values.binary("add", address, scaled);
    }

    if (address === undefined) {
      return this.#values.const(ea.disp);
    }

    return ea.disp === 0
      ? address
      : this.#values.binary("add", address, this.#values.const(ea.disp));
  }

  #linearAddress(segment: SegmentRegister, offset: ValueId): ValueId {
    // Flat-memory assumption: CS/DS/ES/SS bases are zero; FS/GS may be non-zero.
    if (segment !== "fs" && segment !== "gs") {
      return offset;
    }

    return this.#values.binary(
      "add",
      this.#state.segments.readBase(this.#access, segment),
      offset
    );
  }

  #memReference(segment: MemSegmentBinding, offset: ValueId): MemRef {
    switch (segment.kind) {
      case "static":
        return {
          segment: { kind: "static", reg: segment.reg },
          offset
        };
      case "dynamic":
        return {
          segment: { kind: "dynamic", index: this.#values.external(segment.value) },
          offset
        };
    }
  }

  #segmentLinearAddress(segment: SegmentRef, offset: ValueId): ValueId {
    switch (segment.kind) {
      case "static":
        return this.#linearAddress(segment.reg, offset);
      case "dynamic":
        return this.#values.binary(
          "add",
          this.#state.segments.readDynamicBase(this.#access, segment.index),
          offset
        );
    }
  }
}

const scaleShift = { 1: 0, 2: 1, 4: 2, 8: 3 } as const;
