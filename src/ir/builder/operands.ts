import { assert } from "#common/assert.js";
import type {
  SemanticOperandInfo,
  SemanticOperandInput
} from "#x86/semantics/builder.js";
import type { OperandWidth, SegmentRegister } from "#x86/types.js";
import type {
  EffectiveAddressTerms,
  ExternalValueId,
  MemDynamicOperandBinding,
  MemSegmentBinding,
  OperandBinding,
  RegDynamicOperandBinding
} from "../operands.js";
import type { GprDynamicSlot, GprChannel } from "../slots.js";
import type { ValueId, ValueTable } from "../values.js";
import type { State } from "./state/index.js";

export class OperandResolver {
  readonly #values: ValueTable;
  readonly #state: State;
  readonly #operandAddresses = new Map<number, ValueId>();
  readonly #operandLinearAddresses = new Map<number, ValueId>();
  #bindings: readonly OperandBinding[] = [];

  constructor(values: ValueTable, state: State) {
    this.#values = values;
    this.#state = state;
  }

  beginInstruction(bindings: readonly OperandBinding[]): void {
    this.#bindings = bindings;
    this.#operandAddresses.clear();
    this.#operandLinearAddresses.clear();
  }

  endInstruction(): void {
    this.#bindings = [];
    this.#operandAddresses.clear();
    this.#operandLinearAddresses.clear();
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
    const cached = this.#operandAddresses.get(index);

    if (cached !== undefined) {
      return cached;
    }

    const binding = this.binding(index);
    const address = this.#bindingAddress(binding);

    this.#operandAddresses.set(index, address);
    return address;
  }

  linearAddress(index: number): ValueId {
    const cached = this.#operandLinearAddresses.get(index);

    if (cached !== undefined) {
      return cached;
    }

    const binding = this.binding(index);
    const address = this.#bindingLinearAddress(index, binding);

    this.#operandLinearAddresses.set(index, address);
    return address;
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

  #bindingLinearAddress(index: number, binding: OperandBinding): ValueId {
    assert(
      binding.kind === "mem" || binding.kind === "memStatic" || binding.kind === "memDynamic",
      `linear address of a ${binding.kind} operand binding`
    );

    switch (binding.kind) {
      case "mem":
      case "memStatic":
      case "memDynamic":
        return this.#memSegmentLinearAddress(binding.segment, this.address(index));
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

  #linearAddress(segment: SegmentRegister | undefined, offset: ValueId): ValueId {
    // Flat-memory assumption: CS/DS/ES/SS bases are zero; FS/GS may be non-zero.
    if (segment !== "fs" && segment !== "gs") {
      return offset;
    }

    return this.#values.binary("add", this.#state.segments.readBase(segment), offset);
  }

  #memSegmentLinearAddress(segment: MemSegmentBinding, offset: ValueId): ValueId {
    switch (segment.kind) {
      case "none":
        return offset;
      case "static":
        return this.#linearAddress(segment.reg, offset);
      case "dynamic":
        return this.#dynamicSegmentLinearAddress(segment.value, offset);
    }
  }

  #dynamicSegmentLinearAddress(segment: ExternalValueId, offset: ValueId): ValueId {
    return this.#values.binary("add", this.#state.segments.readDynamicBase(this.#values.external(segment)), offset);
  }
}

const scaleShift = { 1: 0, 2: 1, 4: 2, 8: 3 } as const;
const dynamicGprByteLength = { 8: 1, 16: 2, 32: 4 } as const;
