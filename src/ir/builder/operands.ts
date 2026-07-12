import { assert } from "#common/assert.js";
import type {
  SemanticOperandInfo, SemanticOperandInput
} from "#core/semantics/builder.js";
import type { MemRef, SegmentRef } from "#core/semantics/refs.js";
import type { OperandWidth, SegmentRegister } from "#core/types.js";
import type {
  EffectiveAddressTerms, MemDynamicOperandBinding, MemSegmentBinding, OperandBinding, RegDynamicOperandBinding
} from "../operands.js";
import type { GprDynamicSlot, GprChannel } from "../slots.js";
import type { ValueId } from "../values.js";
import { ValueTable } from "../value-table.js";
import type { State } from "./state/index.js";

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
  readonly #state: State;
  readonly #currentScope: () => OperandScope;
  #bindings: readonly OperandBinding[] = [];

  constructor(values: ValueTable, state: State, currentScope: () => OperandScope) {
    this.#values = values;
    this.#state = state;
    this.#currentScope = currentScope;
  }

  beginInstruction(bindings: readonly OperandBinding[]): void {
    this.#bindings = bindings;
    this.#currentScope().clear();
  }

  endInstruction(): void {
    this.#bindings = [];
    this.#currentScope().clear();
  }

  currentBindings(): readonly OperandBinding[] {
    return this.#bindings;
  }

  operandInfo(operandInput: SemanticOperandInput): SemanticOperandInfo {
    const binding = this.binding(operandInput.index);

    switch (binding.kind) {
      case "reg":
        return { storage: "reg" };
      case "segment":
        return { storage: "reg", segment: { kind: "static", reg: binding.channel.reg } };
      case "imm":
        return { storage: "imm" };
      case "mem":
      case "memStatic":
      case "memDynamic":
        return { storage: "mem" };
      case "regDynamic":
        return { storage: "reg" };
      case "segmentDynamic":
        return { storage: "reg", segment: { kind: "dynamic", index: this.#values.external(binding.index) } };
      case "immExternal":
        return { storage: "imm" };
    }
  }

  binding(index: number): OperandBinding {
    const binding = this.#bindings[index];

    assert(binding !== undefined, `missing operand binding for operand ${index}`);
    return binding;
  }

  address(index: number): ValueId {
    const scope = this.#currentScope();
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

  dynamicGprSlot(binding: RegDynamicOperandBinding, accessWidth: OperandWidth): GprDynamicSlot {
    return {
      kind: "gprDynamic",
      index: this.#values.external(binding.index),
      byteLength: dynamicGprByteLength[accessWidth]
    };
  }

  operandUsesDynamicGpr(index: number): boolean {
    const binding = this.binding(index);

    return binding.kind === "regDynamic" || binding.kind === "memDynamic";
  }

  operandGprChannel(index: number): GprChannel | undefined {
    const binding = this.binding(index);

    return binding.kind === "reg" ? binding.channel : undefined;
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
    const base = this.#state.gpr.readDynamic({
      kind: "gprDynamic",
      index: this.#values.external(binding.base),
      byteLength: 4
    });

    return this.#values.binary("add", base, this.#values.external(binding.offset));
  }

  #effectiveAddress(ea: EffectiveAddressTerms): ValueId {
    let address: ValueId | undefined;

    if (ea.base !== undefined) {
      address = this.#state.gpr.read(ea.base);
    }

    if (ea.index !== undefined) {
      const index = this.#state.gpr.read(ea.index);
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

    return this.#values.binary("add", this.#state.segments.readBase(segment), offset);
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
        return this.#values.binary("add", this.#state.segments.readDynamicBase(segment.index), offset);
    }
  }
}

const scaleShift = { 1: 0, 2: 1, 4: 2, 8: 3 } as const;
const dynamicGprByteLength = { 8: 1, 16: 2, 32: 4 } as const;
