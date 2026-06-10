import { assert } from "#common/assert.js";
import { CONDITIONS, type FlagBoolExpr } from "#ir/model/conditions.js";
import type { FlagName } from "#ir/model/flags.js";
import { const32, irVar, mem, nextEip, operand, reg, toStorageRef, toValueRef } from "#ir/model/refs.js";
import type {
  ConditionCode,
  IrBinaryOperator,
  IrBuilder,
  IrCompareOperator,
  IrConstValueRef,
  IrFlagWriteCell,
  IrFlagWriteInput,
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
import { createPendingChannels } from "./pending.js";
import { eipChannel, flagChannel } from "./slots.js";
import type { Action, ActionBlock, RegionId } from "./types.js";
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
  readonly #pending = createPendingChannels(this.#values, (action) => this.#actions.push(action));
  // Fused condition expressions from the latest writeFlags; condition()
  // prefers these over recomputing from flag bytes. Any flag write
  // invalidates all earlier entries: they were derived from flag state that
  // is now stale.
  readonly #conditions = new Map<ConditionCode, ValueId>();
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

    this.#pending.flushAll();
    this.#actions.push({ kind: "exit", reason: "next" });

    return {
      entry: entryRegionId,
      regions: [{ id: entryRegionId, kind: "entry", actions: this.#actions }],
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

    switch (binding.kind) {
      case "imm": {
        const value = this.#values.internConst(binding.value);

        return irVar(
          options.signed === true
            ? this.#values.extendTo(accessWidth, value)
            : this.#values.projectTo(accessWidth, value)
        );
      }
      case "reg":
        assert(
          binding.channel.byteLength * 8 === accessWidth,
          `${accessWidth}-bit get from a ${binding.channel.byteLength * 8}-bit register channel`
        );
        return irVar(this.#pending.read(binding.channel, options));
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

    assert(
      binding.channel.byteLength * 8 === accessWidth,
      `${accessWidth}-bit set to a ${binding.channel.byteLength * 8}-bit register channel`
    );
    this.#pending.write(binding.channel, this.#valueId(value));
  }

  next(): void {
    this.#beforeOp("next");
    this.#pending.write(eipChannel, this.#values.internConst(this.#location().nextEip));
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
    this.#beforeOp("i32Extend8S");
    return irVar(this.#values.extendTo(8, this.#valueId(value)));
  }

  i32Extend16S(value: ValueInput): VarRef {
    this.#beforeOp("i32Extend16S");
    return irVar(this.#values.extendTo(16, this.#valueId(value)));
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
    return irVar(this.#values.projectTo(width, this.#valueId(value)));
  }

  compare(width: OperandWidth, operator: IrCompareOperator, a: ValueInput, b: ValueInput): VarRef {
    this.#beforeOp("compare");
    // Narrow compares lower by predicate class: signed predicates need
    // sign-extended operands, the rest masked ones.
    const lower = signedComparePredicates.has(operator)
      ? (id: ValueId) => this.#values.extendTo(width, id)
      : (id: ValueId) => this.#values.projectTo(width, id);

    return irVar(
      this.#values.internCompare(operator, lower(this.#valueId(a)), lower(this.#valueId(b)))
    );
  }

  flagExpr(value: ValueInput): IrFlagWriteCell {
    return { kind: "expr", value: toValueRef(value) };
  }

  flagUndef(): IrFlagWriteCell {
    return { kind: "undef" };
  }

  writeFlags(write: IrFlagWriteInput): void {
    this.#beforeOp("writeFlags");

    for (const [flag, cell] of Object.entries(write.cells) as [FlagName, IrFlagWriteCell][]) {
      // undef -> preserve: any value is architecturally allowed, so keeping
      // the old one is free and kills the write.
      if (cell.kind === "expr") {
        this.#pending.write(flagChannel(flag), this.#valueId(cell.value));
      }
    }

    this.#conditions.clear();

    if (write.conditions !== undefined) {
      for (const [cc, value] of Object.entries(write.conditions) as [ConditionCode, ValueInput][]) {
        this.#conditions.set(cc, this.#valueId(value));
      }
    }
  }

  condition(cc: ConditionCode): VarRef {
    this.#beforeOp("condition");

    const recorded = this.#conditions.get(cc);

    if (recorded !== undefined) {
      return irVar(recorded);
    }

    return irVar(this.#flagBoolExpr(CONDITIONS[cc].expr));
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

  // Flag channel values are 0/1 bytes, so the boolean algebra is plain
  // bitwise math and "not" is a compare against zero.
  #flagBoolExpr(expr: FlagBoolExpr): ValueId {
    switch (expr.kind) {
      case "flag":
        return this.#pending.read(flagChannel(expr.flag));
      case "not":
        return this.#values.internCompare("eq", this.#flagBoolExpr(expr.value), this.#values.internConst(0));
      case "and":
        return this.#values.internBinary("and", this.#flagBoolExpr(expr.a), this.#flagBoolExpr(expr.b));
      case "or":
        return this.#values.internBinary("or", this.#flagBoolExpr(expr.a), this.#flagBoolExpr(expr.b));
      case "xor":
        return this.#values.internBinary("xor", this.#flagBoolExpr(expr.a), this.#flagBoolExpr(expr.b));
    }
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

const signedComparePredicates: ReadonlySet<IrCompareOperator> = new Set([
  "lt_s",
  "le_s",
  "gt_s",
  "ge_s"
]);

function notSupportedError(what: string): Error {
  return new Error(`${what} not supported by action builder yet`);
}
