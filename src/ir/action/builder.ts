import { assert } from "#common/assert.js";
import { const32, irVar, mem, nextEip, operand, reg, toStorageRef, toValueRef } from "#ir/model/refs.js";
import type {
  IrBuilder,
  IrConstValueRef,
  IrFlagWriteCell,
  IrGetOptions,
  MemRef,
  NextEipRef,
  OperandRef,
  RegRef,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  SemanticTemplate,
  StorageInput,
  ValueInput,
  VarRef
} from "#ir/model/types.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import type { OperandBinding } from "./operands.js";
import { eipChannel } from "./slots.js";
import type { Action, ActionBlock, RegionId, StateSlot } from "./types.js";
import { createValueTable, type ValueId } from "./values.js";

export type InstructionLocation = Readonly<{ eip: number; nextEip: number }>;

export type ActionBuilder = Readonly<{
  addInstruction(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): void;
  finish(): ActionBlock;
}>;

export function createActionBuilder(): ActionBuilder {
  const builder = new ActionIrBuilder();

  return {
    addInstruction: (template, bindings, location) => builder.addInstruction(template, bindings, location),
    finish: () => builder.finish()
  };
}

const entryRegionId: RegionId = 0;

class ActionIrBuilder implements IrBuilder, SemanticBuildContext {
  readonly #values = createValueTable();
  readonly #pending = new Map<StateSlot, ValueId>();
  #bindings: readonly OperandBinding[] = [];
  #instruction: InstructionLocation | undefined;
  #terminated = false;
  #finished = false;

  addInstruction(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): void {
    assert(!this.#finished, "cannot add instructions to a finished action builder");
    assert(this.#instruction === undefined, "action builder has an incomplete instruction");

    this.#bindings = bindings;
    this.#instruction = location;
    this.#terminated = false;

    template(this, this);

    if (!this.#terminated) {
      this.next();
    }

    // Cleared only on success: a template that throws leaves the instruction
    // in place with its partial pendings, poisoning further use.
    this.#instruction = undefined;
    this.#bindings = [];
  }

  finish(): ActionBlock {
    assert(!this.#finished, "action builder is already finished");
    assert(this.#instruction === undefined, "action builder has an incomplete instruction");
    assert(this.#pending.has(eipChannel), "action block did not advance eip; no instructions were added");
    this.#finished = true;

    const actions: Action[] = [];

    for (const [slot, value] of this.#pending) {
      actions.push({ kind: "writeState", slot, value });
    }

    actions.push({ kind: "exit", reason: "next" });

    return {
      entry: entryRegionId,
      regions: [{ id: entryRegionId, kind: "entry", actions }],
      values: this.#values
    };
  }

  operandInfo(operandInput: SemanticOperandInput): SemanticOperandInfo {
    const index = typeof operandInput === "number" ? operandInput : operandInput.index;
    const binding = this.#binding(index);

    switch (binding.kind) {
      case "reg":
        return { storage: "reg" };
      case "imm":
        return { storage: "imm" };
      case "mem":
        return { storage: "mem" };
      case "external":
        throw notSupportedError("external operand binding");
    }
  }

  operand(index: number): OperandRef {
    this.#binding(index);
    return operand(index);
  }

  const32(value: number): IrConstValueRef {
    return const32(value);
  }

  nextEip(): NextEipRef {
    return nextEip();
  }

  reg(regInput: RegName): RegRef {
    return reg(regInput);
  }

  mem(address: ValueInput): MemRef {
    return mem(address);
  }

  get(source: StorageInput, accessWidth: OperandWidth = 32, options: IrGetOptions = {}): VarRef {
    this.#beforeOp("get");
    const storage = toStorageRef(source);

    if (storage.kind !== "operand") {
      throw notSupportedError(`get from ${storage.kind} storage`);
    }

    const binding = this.#binding(storage.index);

    if (binding.kind !== "imm") {
      throw notSupportedError(`get from ${binding.kind} operand binding`);
    }

    if (accessWidth !== 32) {
      throw notSupportedError(`${accessWidth}-bit get`);
    }

    if (options.signed === true) {
      throw notSupportedError("signed get");
    }

    return irVar(this.#values.internConst(binding.value));
  }

  set(target: StorageInput, value: ValueInput, accessWidth: OperandWidth = 32): void {
    this.#beforeOp("set");
    const storage = toStorageRef(target);

    if (storage.kind !== "operand") {
      throw notSupportedError(`set to ${storage.kind} storage`);
    }

    const binding = this.#binding(storage.index);

    if (binding.kind !== "reg") {
      throw notSupportedError(`set to ${binding.kind} operand binding`);
    }

    if (accessWidth !== 32 || binding.channel.byteLength !== 4) {
      throw notSupportedError(`${accessWidth}-bit register set`);
    }

    this.#pending.set(binding.channel, this.#valueId(value));
  }

  next(): void {
    this.#beforeOp("next");
    this.#pending.set(eipChannel, this.#values.internConst(this.#location().nextEip));
    this.#terminated = true;
  }

  memoryGuard(): void {
    throw notSupportedError("memoryGuard");
  }

  address(): VarRef {
    throw notSupportedError("address");
  }

  i32Add(): VarRef {
    throw notSupportedError("i32Add");
  }

  i32Sub(): VarRef {
    throw notSupportedError("i32Sub");
  }

  i32Xor(): VarRef {
    throw notSupportedError("i32Xor");
  }

  i32Or(): VarRef {
    throw notSupportedError("i32Or");
  }

  i32And(): VarRef {
    throw notSupportedError("i32And");
  }

  i32Shl(): VarRef {
    throw notSupportedError("i32Shl");
  }

  i32ShrU(): VarRef {
    throw notSupportedError("i32ShrU");
  }

  i32Extend8S(): VarRef {
    throw notSupportedError("i32Extend8S");
  }

  i32Extend16S(): VarRef {
    throw notSupportedError("i32Extend16S");
  }

  i32Popcnt(): VarRef {
    throw notSupportedError("i32Popcnt");
  }

  i32Select(): VarRef {
    throw notSupportedError("i32Select");
  }

  project(): VarRef {
    throw notSupportedError("project");
  }

  compare(): VarRef {
    throw notSupportedError("compare");
  }

  setFlags(): void {
    throw notSupportedError("setFlags");
  }

  flagExpr(): IrFlagWriteCell {
    throw notSupportedError("flagExpr");
  }

  flagUndef(): IrFlagWriteCell {
    throw notSupportedError("flagUndef");
  }

  writeFlags(): void {
    throw notSupportedError("writeFlags");
  }

  condition(): VarRef {
    throw notSupportedError("condition");
  }

  jump(): void {
    throw notSupportedError("jump");
  }

  conditionalJump(): void {
    throw notSupportedError("conditionalJump");
  }

  hostTrap(): void {
    throw notSupportedError("hostTrap");
  }

  #valueId(input: ValueInput): ValueId {
    const value = toValueRef(input);

    switch (value.kind) {
      case "const":
        return this.#values.internConst(value.value);
      case "nextEip":
        return this.#values.internConst(this.#location().nextEip);
      case "var": {
        this.#values.node(value.id);
        return value.id;
      }
    }
  }

  #binding(index: number): OperandBinding {
    const binding = this.#bindings[index];

    assert(binding !== undefined, `missing operand binding for operand ${index}`);
    return binding;
  }

  #location(): InstructionLocation {
    assert(this.#instruction !== undefined, "action builder has no current instruction");
    return this.#instruction;
  }

  #beforeOp(op: string): void {
    this.#location();
    assert(!this.#terminated, `cannot emit ${op} after instruction terminator`);
  }
}

function notSupportedError(what: string): Error {
  return new Error(`${what} not supported by action builder yet`);
}
