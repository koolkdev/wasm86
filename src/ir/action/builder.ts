import { assert } from "#common/assert.js";
import { const32, irVar, mem, nextEip, operand, reg, toStorageRef, toValueRef } from "#ir/model/refs.js";
import type {
  IrBinaryOperator,
  IrBuilder,
  IrCompareOperator,
  IrConstValueRef,
  IrFlagWriteCell,
  IrGetOptions,
  IrUnaryOperator,
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
  readonly #actions: Action[] = [];
  readonly #pending = new Map<StateSlot, ValueId>();
  // readState leaf per channel; a channel is read at most once per region.
  // Must be invalidated together with #pending once anything invalidates
  // pendings mid-region (dynamic register writes, barriers) — a stale leaf
  // here would silently serve a channel whose memory has changed.
  readonly #reads = new Map<StateSlot, ValueId>();
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

    const actions = this.#actions;

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

    if (accessWidth !== 32) {
      throw notSupportedError(`${accessWidth}-bit get`);
    }

    if (options.signed === true) {
      throw notSupportedError("signed get");
    }

    switch (binding.kind) {
      case "imm":
        return irVar(this.#values.internConst(binding.value));
      case "reg":
        if (binding.channel.byteLength !== 4) {
          throw notSupportedError(`${binding.channel.byteLength * 8}-bit register get`);
        }

        return irVar(this.#readChannel(binding.channel));
      case "mem":
      case "external":
        throw notSupportedError(`get from ${binding.kind} operand binding`);
    }
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

  i32Add(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("i32Add", "add", a, b);
  }

  i32Sub(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("i32Sub", "sub", a, b);
  }

  i32Xor(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("i32Xor", "xor", a, b);
  }

  i32Or(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("i32Or", "or", a, b);
  }

  i32And(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("i32And", "and", a, b);
  }

  i32Shl(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("i32Shl", "shl", a, b);
  }

  i32ShrU(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("i32ShrU", "shr_u", a, b);
  }

  i32Extend8S(value: ValueInput): VarRef {
    return this.#unary("i32Extend8S", "extend8_s", value);
  }

  i32Extend16S(value: ValueInput): VarRef {
    return this.#unary("i32Extend16S", "extend16_s", value);
  }

  i32Popcnt(value: ValueInput): VarRef {
    return this.#unary("i32Popcnt", "popcnt", value);
  }

  i32Select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): VarRef {
    this.#beforeOp("i32Select");
    return irVar(
      this.#values.internSelect(this.#valueId(condition), this.#valueId(whenTrue), this.#valueId(whenFalse))
    );
  }

  project(width: OperandWidth, value: ValueInput): VarRef {
    this.#beforeOp("project");
    return irVar(this.#values.internProject(width, this.#valueId(value)));
  }

  compare(width: OperandWidth, operator: IrCompareOperator, a: ValueInput, b: ValueInput): VarRef {
    this.#beforeOp("compare");
    return irVar(this.#values.internCompare(width, operator, this.#valueId(a), this.#valueId(b)));
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

  #binary(op: string, operator: IrBinaryOperator, a: ValueInput, b: ValueInput): VarRef {
    this.#beforeOp(op);
    return irVar(this.#values.internBinary(operator, this.#valueId(a), this.#valueId(b)));
  }

  #unary(op: string, operator: IrUnaryOperator, value: ValueInput): VarRef {
    this.#beforeOp(op);
    return irVar(this.#values.internUnary(operator, this.#valueId(value)));
  }

  #readChannel(channel: StateSlot): ValueId {
    const pending = this.#pending.get(channel);

    if (pending !== undefined) {
      return pending;
    }

    const existing = this.#reads.get(channel);

    if (existing !== undefined) {
      return existing;
    }

    const output = this.#values.addActionOutput();

    this.#actions.push({ kind: "readState", output, slot: channel });
    this.#reads.set(channel, output);
    return output;
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
