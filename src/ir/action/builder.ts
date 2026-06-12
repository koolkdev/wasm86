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
  IrMemoryAccessKind,
  IrUnaryOperator,
  MemRef,
  NextEipRef,
  OperandInput,
  OperandRef,
  RegRef,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  SemanticTemplate,
  StorageInput,
  TargetInput,
  ValueInput,
  VarRef
} from "#ir/model/types.js";
import type { EffectiveAddress, OperandWidth, RegName } from "#x86/types.js";
import type {
  ExternalValueId,
  MemDynamicOperandBinding,
  OperandBinding,
  RegDynamicOperandBinding
} from "./operands.js";
import { createPendingChannels } from "./pending.js";
import {
  eipChannel,
  flagChannel,
  gprChannel,
  instructionCountChannel,
  type GprChannel,
  type StateChannel
} from "./slots.js";
import type {
  Action,
  ActionBlock,
  EdgeRegion,
  ExitAction,
  GprDynamicSlot,
  RegionId,
  WriteStateAction
} from "./types.js";
import {
  createValueTable,
  fitsUnsigned,
  signExtended,
  type ValueId,
  type WidthBounds
} from "./values.js";

// A location value is a compile-time constant (block compilation) or an
// external supplied by the host function (interpreter dispatch).
export type LocationValue = number | Readonly<{ external: ExternalValueId }>;

export type InstructionLocation = Readonly<{ eip: LocationValue; nextEip: LocationValue }>;

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
  readonly #edgeRegions: EdgeRegion[] = [];
  // An effective address is computed once per operand, at its first use —
  // x86 computes an EA once, so later uses (the store) see the same address
  // even when the instruction rewrites a base register in between.
  readonly #operandAddresses = new Map<number, ValueId>();
  #nextRegionId: RegionId = entryRegionId + 1;
  #bindings: readonly OperandBinding[] = [];
  #instruction: InstructionLocation | undefined;
  #instructionCountBase: ValueId | undefined;
  #instructionsCompleted = 0;
  #terminated = false;
  #wroteMemory = false;
  #finished = false;
  // "terminated" means the entry region already holds its terminator.
  #blockEnd: "fallthrough" | "jump" | "terminated" = "fallthrough";

  addInstruction(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): void {
    assert(!this.#finished, "cannot add instructions to a finished action builder");
    assert(this.#blockEnd === "fallthrough", "cannot add instructions after a block terminator");
    assert(this.#instruction === undefined, "action builder has an incomplete instruction");

    this.#bindings = bindings;
    this.#operandAddresses.clear();
    this.#instruction = location;
    this.#terminated = false;
    this.#wroteMemory = false;
    this.#pending.beginInstruction();

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
    this.#finished = true;

    switch (this.#blockEnd) {
      case "fallthrough":
      case "jump":
        assert(this.#pending.has(eipChannel), "action block did not advance eip; no instructions were added");
        this.#pending.flushAll();
        this.#actions.push({ kind: "exit", reason: this.#blockEnd === "jump" ? "jump" : "next" });
        break;
      case "terminated":
        break;
    }

    return {
      entry: entryRegionId,
      regions: [
        { id: entryRegionId, kind: "entry", actions: this.#actions },
        ...this.#edgeRegions
      ],
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
      case "memStatic":
      case "memDynamic":
        return { storage: "mem" };
      case "regDynamic":
        // A runtime register index: register storage, dynamic channel.
        return { storage: "reg" };
      case "immExternal":
        // A runtime value with no storage cell, e.g. a decoded immediate.
        return { storage: "imm" };
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

    switch (storage.kind) {
      case "reg":
        return irVar(this.#readChannel(gprChannel(storage.reg), accessWidth, options));
      case "mem":
        return irVar(this.#readMemory(this.#valueId(storage.address), accessWidth, options));
      case "operand": {
        const binding = this.#binding(storage.index);

        switch (binding.kind) {
          case "imm":
            return irVar(this.#widthAdjusted(this.#values.internConst(binding.value), accessWidth, options));
          case "immExternal":
            return irVar(this.#widthAdjusted(this.#values.internExternal(binding.value), accessWidth, options));
          case "reg":
            return irVar(this.#readChannel(binding.channel, accessWidth, options));
          case "mem":
          case "memStatic":
          case "memDynamic":
            return irVar(this.#readMemory(this.#operandAddress(storage.index), accessWidth, options));
          case "regDynamic":
            return irVar(this.#pending.readDynamicGpr(this.#dynamicGprSlot(binding, accessWidth), options));
        }
      }
    }
  }

  set(target: StorageInput, value: ValueInput, accessWidth: OperandWidth = 32): void {
    this.#beforeOp("set");
    const storage = toStorageRef(target);

    switch (storage.kind) {
      case "reg":
        this.#writeChannel(gprChannel(storage.reg), value, accessWidth);
        return;
      case "mem":
        this.#writeMemory(this.#valueId(storage.address), value, accessWidth);
        return;
      case "operand": {
        const binding = this.#binding(storage.index);

        switch (binding.kind) {
          case "reg":
            this.#writeChannel(binding.channel, value, accessWidth);
            return;
          case "mem":
          case "memStatic":
          case "memDynamic":
            this.#writeMemory(this.#operandAddress(storage.index), value, accessWidth);
            return;
          case "regDynamic":
            this.#pending.writeDynamicGpr(this.#dynamicGprSlot(binding, accessWidth), this.#valueId(value));
            return;
          case "imm":
          case "immExternal":
            throw notSupportedError(`set to ${binding.kind} operand binding`);
        }
      }
    }
  }

  next(): void {
    this.#beforeOp("next");
    this.#advanceInstructionCount();
    this.#pending.write(eipChannel, this.#locationValueId(this.#location().nextEip));
    this.#terminated = true;
  }

  memoryGuard(address: ValueInput, byteLength: number, access: IrMemoryAccessKind): void {
    this.#beforeOp("memoryGuard");
    // Guest memory cannot be rolled back by any scheme, so a fault edge
    // cannot restore the pre-instruction state once the instruction stored.
    assert(!this.#wroteMemory, "a memory guard cannot follow a memory write in the same instruction");

    const addressId = this.#valueId(address);

    this.#actions.push({
      kind: "guardMemory",
      address: addressId,
      byteLength,
      access,
      faultEdge: this.#faultEdge(access === "read" ? "memoryReadFault" : "memoryWriteFault", addressId)
    });
  }

  address(operandRef: OperandInput): VarRef {
    this.#beforeOp("address");
    return irVar(this.#operandAddress(operandRef.index));
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

  jump(target: TargetInput): void {
    this.#beforeOp("jump");
    this.#advanceInstructionCount();
    this.#pending.write(eipChannel, this.#valueId(target));
    this.#blockEnd = "jump";
    this.#terminated = true;
  }

  conditionalJump(condition: ValueInput, taken: TargetInput, notTaken: TargetInput): void {
    this.#beforeOp("conditionalJump");
    this.#advanceInstructionCount();

    const conditionId = this.#valueId(condition);

    this.#actions.push({
      kind: "branch",
      condition: conditionId,
      taken: this.#branchEdge("jump", taken),
      notTaken: this.#branchEdge("next", notTaken)
    });
    this.#blockEnd = "terminated";
    this.#terminated = true;
  }

  // A trap resumes at the next instruction with all state observable.
  hostTrap(vector: ValueInput): void {
    this.#beforeOp("hostTrap");
    this.#advanceInstructionCount();

    const vectorId = this.#valueId(vector);

    this.#pending.write(eipChannel, this.#locationValueId(this.#location().nextEip));
    this.#pending.flushAll();
    this.#actions.push({ kind: "exit", reason: "hostTrap", payload: vectorId });
    this.#blockEnd = "terminated";
    this.#terminated = true;
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

  // The snapshot leaves the main-path map untouched. Pending eip holds the
  // previous instruction's nextEip; the edge stores the faulting eip instead.
  #faultEdge(reason: "memoryReadFault" | "memoryWriteFault", address: ValueId): RegionId {
    return this.#edgeRegion(
      { kind: "exit", reason, payload: address },
      this.#pending.snapshot(),
      this.#locationValueId(this.#location().eip)
    );
  }

  // Branch edges observe the completed instruction, so they flush live
  // pendings.
  #branchEdge(reason: "jump" | "next", target: TargetInput): RegionId {
    return this.#edgeRegion({ kind: "exit", reason }, this.#pending.entries(), this.#valueId(target));
  }

  #edgeRegion(
    exit: ExitAction,
    pendings: ReadonlyArray<readonly [StateChannel, ValueId]>,
    eipValue: ValueId
  ): RegionId {
    const flushes: WriteStateAction[] = [];
    let wroteEip = false;

    for (const [slot, value] of pendings) {
      if (slot === eipChannel) {
        wroteEip = true;
        flushes.push({ kind: "writeState", slot, value: eipValue });
      } else {
        flushes.push({ kind: "writeState", slot, value });
      }
    }

    if (!wroteEip) {
      flushes.push({ kind: "writeState", slot: eipChannel, value: eipValue });
    }

    const id = this.#nextRegionId;

    this.#nextRegionId += 1;
    this.#edgeRegions.push({ id, kind: "edge", flushes, exit });
    return id;
  }

  // Every terminator advances the count: fault edges snapshot the
  // instruction boundary, so a faulting instruction never counts. The value
  // is always base + completed off the block's one read, so a flush stores
  // a single folded add.
  #advanceInstructionCount(): void {
    this.#instructionCountBase ??= this.#pending.read(instructionCountChannel);
    this.#instructionsCompleted += 1;
    this.#pending.write(
      instructionCountChannel,
      this.#values.internBinary(
        "add",
        this.#instructionCountBase,
        this.#values.internConst(this.#instructionsCompleted)
      )
    );
  }

  #dynamicGprSlot(binding: RegDynamicOperandBinding, accessWidth: OperandWidth): GprDynamicSlot {
    return {
      kind: "gprDynamic",
      index: this.#values.internExternal(binding.index),
      byteLength: dynamicGprByteLength[accessWidth]
    };
  }

  #widthAdjusted(value: ValueId, accessWidth: OperandWidth, options: IrGetOptions): ValueId {
    return options.signed === true
      ? this.#values.extendTo(accessWidth, value)
      : this.#values.projectTo(accessWidth, value);
  }

  #locationValueId(value: LocationValue): ValueId {
    return typeof value === "number"
      ? this.#values.internConst(value)
      : this.#values.internExternal(value.external);
  }

  #readChannel(channel: GprChannel, accessWidth: OperandWidth, options: IrGetOptions): ValueId {
    assert(
      channel.byteLength * 8 === accessWidth,
      `${accessWidth}-bit get from a ${channel.byteLength * 8}-bit register channel`
    );
    return this.#pending.read(channel, options);
  }

  #writeChannel(channel: GprChannel, value: ValueInput, accessWidth: OperandWidth): void {
    assert(
      channel.byteLength * 8 === accessWidth,
      `${accessWidth}-bit set to a ${channel.byteLength * 8}-bit register channel`
    );
    this.#pending.write(channel, this.#valueId(value));
  }

  #readMemory(address: ValueId, width: OperandWidth, options: IrGetOptions): ValueId {
    // Sign-extension is meaningful only below the word, as in pending reads.
    const signed = options.signed === true && width !== 32;
    const output = this.#values.addActionOutput(memoryReadBounds(width, signed));

    this.#actions.push(
      signed
        ? { kind: "readMemory", output, address, width, signed: true }
        : { kind: "readMemory", output, address, width }
    );
    return output;
  }

  #writeMemory(address: ValueId, value: ValueInput, width: OperandWidth): void {
    this.#wroteMemory = true;
    this.#actions.push({ kind: "writeMemory", address, value: this.#valueId(value), width });
  }

  #operandAddress(index: number): ValueId {
    const cached = this.#operandAddresses.get(index);

    if (cached !== undefined) {
      return cached;
    }

    const binding = this.#binding(index);
    const address = this.#bindingAddress(binding);

    this.#operandAddresses.set(index, address);
    return address;
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
        return this.#values.internExternal(binding.address);
      case "memDynamic":
        return this.#dynamicAddress(binding);
    }
  }

  #dynamicAddress(binding: MemDynamicOperandBinding): ValueId {
    const base = this.#pending.readDynamicGpr({
      kind: "gprDynamic",
      index: this.#values.internExternal(binding.base),
      byteLength: 4
    });

    return this.#values.internBinary("add", base, this.#values.internExternal(binding.offset));
  }

  #effectiveAddress(ea: EffectiveAddress): ValueId {
    let address: ValueId | undefined;

    if (ea.base !== undefined) {
      address = this.#pending.read(gprChannel(ea.base));
    }

    if (ea.index !== undefined) {
      const index = this.#pending.read(gprChannel(ea.index));
      const scaled = ea.scale === 1
        ? index
        : this.#values.internBinary("shl", index, this.#values.internConst(scaleShift[ea.scale]));

      address = address === undefined ? scaled : this.#values.internBinary("add", address, scaled);
    }

    if (address === undefined) {
      return this.#values.internConst(ea.disp);
    }

    return ea.disp === 0
      ? address
      : this.#values.internBinary("add", address, this.#values.internConst(ea.disp));
  }

  #valueId(input: ValueInput): ValueId {
    const value = toValueRef(input);

    switch (value.kind) {
      case "const":
        return this.#values.internConst(value.value);
      case "nextEip":
        return this.#locationValueId(this.#location().nextEip);
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

const scaleShift = { 1: 0, 2: 1, 4: 2, 8: 3 } as const;

const dynamicGprByteLength = { 8: 1, 16: 2, 32: 4 } as const;

function memoryReadBounds(width: OperandWidth, signed: boolean): WidthBounds | undefined {
  if (width === 32) {
    return undefined;
  }

  return signed ? signExtended(width) : fitsUnsigned(width);
}

function notSupportedError(what: string): Error {
  return new Error(`${what} not supported by action builder yet`);
}
