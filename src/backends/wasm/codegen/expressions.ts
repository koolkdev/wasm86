import {
  flagProducerConditionInputNames,
  requiredFlagProducerConditionInput,
  type IrFlagProducerConditionDescriptor
} from "#x86/ir/model/flag-conditions.js";
import type {
  ConditionCode,
  IrBinaryOperator,
  IrFlagSetOp,
  OperandRef,
  RegRef,
  IrOp,
  IrUnaryOperator,
  IrValueType,
  StorageRef,
  ValueRef,
  VarRef
} from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";

export type IrStorageExpr =
  | OperandRef
  | RegRef
  | Readonly<{ kind: "mem"; address: IrValueExpr }>;

export type IrValueExpr =
  | ValueRef
  | Readonly<{ kind: "source"; source: IrStorageExpr; accessWidth: OperandWidth; signed?: boolean }>
  | Readonly<{ kind: "address"; operand: OperandRef }>
  | Readonly<{ kind: "aluFlags.condition"; cc: ConditionCode }>
  | Readonly<{
      kind: "flagProducer.condition";
      cc: ConditionCode;
      producer: IrFlagProducerConditionDescriptor["producer"];
      width?: IrFlagProducerConditionDescriptor["width"];
      writtenMask: IrFlagProducerConditionDescriptor["writtenMask"];
      undefMask: IrFlagProducerConditionDescriptor["undefMask"];
      inputs: Readonly<Record<string, ValueRef>>;
    }>
  | Readonly<{
      kind: "value.binary";
      type: IrValueType;
      operator: IrBinaryOperator;
      a: IrValueExpr;
      b: IrValueExpr;
    }>
  | Readonly<{
      kind: "value.unary";
      type: IrValueType;
      operator: IrUnaryOperator;
      value: IrValueExpr;
    }>
  | Readonly<{
      kind: "value.select";
      type: IrValueType;
      condition: IrValueExpr;
      whenTrue: IrValueExpr;
      whenFalse: IrValueExpr;
    }>;

export type IrSetExprOp = Readonly<{
  op: "set";
  target: IrStorageExpr;
  value: IrValueExpr;
  accessWidth: OperandWidth;
  role?: IrSetExprRole;
}>;

export type IrSetExprRole = "registerMaterialization";

export type IrExprOp =
  | Readonly<{ op: "let32"; dst: VarRef; value: IrValueExpr }>
  | IrSetExprOp
  | Readonly<{
      op: "set.if";
      condition: IrValueExpr;
      target: IrStorageExpr;
      value: IrValueExpr;
      accessWidth: OperandWidth;
    }>
  | IrFlagSetOp
  | Readonly<{ op: "flags.materialize"; mask: number }>
  | Readonly<{ op: "flags.boundary"; mask: number }>
  | Readonly<{ op: "next" }>
  | Readonly<{ op: "jump"; target: IrValueExpr }>
  | Readonly<{ op: "conditionalJump"; condition: IrValueExpr; taken: IrValueExpr; notTaken: IrValueExpr }>
  | Readonly<{ op: "hostTrap"; vector: IrValueExpr }>;

export type IrExprBlock = readonly IrExprOp[];

export type IrExpressionFlagProducerConditionOp = IrFlagProducerConditionDescriptor & Readonly<{
  op: "flagProducer.condition";
  dst: VarRef;
}>;

export type IrExpressionSetInputOp = Extract<IrOp, { op: "set" }> & Readonly<{
  role?: IrSetExprRole;
}>;

export type IrExpressionInputOp =
  | Exclude<IrOp, Extract<IrOp, { op: "set" }>>
  | IrExpressionSetInputOp
  | IrExpressionFlagProducerConditionOp;
export type IrExpressionInputBlock = readonly IrExpressionInputOp[];

export type IrExpressionAliasModel = Readonly<{
  storageMayAlias?: (write: StorageRef, read: StorageRef) => boolean;
}>;

export type IrExpressionOptions = Readonly<{
  canInlineGet?: (source: StorageRef) => boolean;
  alias?: IrExpressionAliasModel;
}>;

export function buildIrExpressionBlock(
  block: IrExpressionInputBlock,
  options: IrExpressionOptions = {}
): IrExprBlock {
  const builder = new ExpressionBuilder(block, options);

  return builder.build();
}

class ExpressionBuilder {
  readonly #bindings = new Map<number, IrValueExpr>();
  readonly #ops: IrExprOp[] = [];
  readonly #useCounts: ReadonlyMap<number, number>;
  readonly #conditionalWriteValueVars: ReadonlySet<number>;

  constructor(
    readonly block: IrExpressionInputBlock,
    readonly options: IrExpressionOptions
  ) {
    this.#useCounts = countVarUses(block);
    this.#conditionalWriteValueVars = conditionalWriteValueVars(block);
  }

  build(): IrExprBlock {
    for (let opIndex = 0; opIndex < this.block.length; opIndex += 1) {
      const op = this.block[opIndex];

      if (op === undefined) {
        throw new Error(`missing IR expression input op: ${opIndex}`);
      }

      switch (op.op) {
        case "get":
          this.#defineValue(
            op.dst,
            {
              kind: "source",
              source: this.#storageExpr(op.source),
              accessWidth: op.accessWidth ?? 32,
              ...(op.signed === true ? { signed: true } : {})
            },
            this.options.canInlineGet?.(op.source) === true &&
              !this.#inlineGetWouldCrossAliasBarrier(op.dst, op.source, opIndex)
          );
          break;
        case "set":
          this.#ops.push(this.#setExpr(op));
          break;
        case "set.if":
          this.#ops.push({
            op: "set.if",
            condition: this.#valueExpr(op.condition),
            target: this.#storageExpr(op.target),
            value: this.#valueExpr(this.#materializedValue(op.value)),
            accessWidth: op.accessWidth ?? 32
          });
          break;
        case "address":
          this.#defineValue(op.dst, { kind: "address", operand: op.operand }, true);
          break;
        case "value.const":
          this.#bindings.set(op.dst.id, { kind: "const", type: op.type, value: op.value });
          break;
        case "value.binary":
          this.#defineValue(op.dst, {
            kind: "value.binary",
            type: op.type,
            operator: op.operator,
            a: this.#valueExpr(op.a),
            b: this.#valueExpr(op.b)
          }, true);
          break;
        case "value.unary":
          this.#defineValue(op.dst, {
            kind: "value.unary",
            type: op.type,
            operator: op.operator,
            value: this.#valueExpr(op.value)
          }, true);
          break;
        case "value.select":
          this.#defineValue(op.dst, {
            kind: "value.select",
            type: op.type,
            condition: this.#valueExpr(op.condition),
            whenTrue: this.#valueExpr(op.whenTrue),
            whenFalse: this.#valueExpr(op.whenFalse)
          }, true);
          break;
        case "aluFlags.condition":
          this.#defineValue(op.dst, { kind: "aluFlags.condition", cc: op.cc }, false);
          break;
        case "flagProducer.condition":
          this.#defineValue(op.dst, {
            kind: "flagProducer.condition",
            cc: op.cc,
            producer: op.producer,
            ...(op.width === undefined ? {} : { width: op.width }),
            writtenMask: op.writtenMask,
            undefMask: op.undefMask,
            inputs: this.#materializedFlagProducerConditionInputs(op)
          }, true);
          break;
        case "flags.set":
          this.#ops.push({
            op: "flags.set",
            producer: op.producer,
            ...(op.width === undefined ? {} : { width: op.width }),
            writtenMask: op.writtenMask,
            undefMask: op.undefMask,
            inputs: Object.fromEntries(
              Object.entries(op.inputs).map(([name, value]) => [name, this.#materializedValue(value)])
            )
          });
          break;
        case "flags.materialize":
          this.#ops.push(op);
          break;
        case "flags.boundary":
          this.#ops.push(op);
          break;
        case "next":
          this.#ops.push(op);
          break;
        case "jump":
          this.#ops.push({ op: "jump", target: this.#valueExpr(op.target) });
          break;
        case "conditionalJump":
          this.#ops.push({
            op: "conditionalJump",
            condition: this.#valueExpr(op.condition),
            taken: this.#valueExpr(op.taken),
            notTaken: this.#valueExpr(op.notTaken)
          });
          break;
        case "hostTrap":
          this.#ops.push({ op: "hostTrap", vector: this.#valueExpr(op.vector) });
          break;
      }
    }

    return this.#ops;
  }

  #inlineGetWouldCrossAliasBarrier(dst: VarRef, readStorage: StorageRef, opIndex: number): boolean {
    for (let index = opIndex + 1; index < this.block.length; index += 1) {
      const op = this.block[index];

      if (op === undefined) {
        throw new Error(`missing IR expression input op: ${index}`);
      }

      if (opUsesVar(op, dst.id)) {
        return false;
      }

      if (opWriteStorages(op).some((writeStorage) =>
        storagesMayAlias(writeStorage, readStorage, this.options.alias)
      )) {
        return true;
      }
    }

    return false;
  }

  #defineValue(dst: VarRef, value: IrValueExpr, inlineable: boolean): void {
    if (inlineable && remainingUses(this.#useCounts, dst.id) <= 1 && !this.#conditionalWriteValueVars.has(dst.id)) {
      this.#bindings.set(dst.id, value);
      return;
    }

    this.#ops.push({ op: "let32", dst, value });
  }

  #setExpr(op: Extract<IrExpressionInputOp, { op: "set" }>): IrSetExprOp {
    const expr: IrSetExprOp = {
      op: "set",
      target: this.#storageExpr(op.target),
      value: this.#valueExpr(op.value),
      accessWidth: op.accessWidth ?? 32
    };

    return op.role === undefined ? expr : { ...expr, role: op.role };
  }

  #materializedValue(value: ValueRef): ValueRef {
    const expr = this.#valueExpr(value);

    if (expr.kind === "var" || expr.kind === "const" || expr.kind === "nextEip") {
      return expr;
    }

    const materialized = value.kind === "var" ? value : undefined;

    if (materialized === undefined) {
      throw new Error("cannot materialize non-var IR expression input");
    }

    this.#ops.push({ op: "let32", dst: materialized, value: expr });
    this.#bindings.delete(materialized.id);
    return materialized;
  }

  #materializedFlagProducerConditionInputs(op: IrFlagProducerConditionDescriptor): Readonly<Record<string, ValueRef>> {
    return Object.fromEntries(
      flagProducerConditionInputNames(op).map((name) => [
        name,
        this.#materializedValue(requiredFlagProducerConditionInput(op, name))
      ])
    );
  }

  #storageExpr(storage: StorageRef): IrStorageExpr {
    switch (storage.kind) {
      case "operand":
      case "reg":
        return storage;
      case "mem":
        return { kind: "mem", address: this.#valueExpr(storage.address) };
    }
  }

  #valueExpr(value: ValueRef): IrValueExpr {
    if (value.kind !== "var") {
      return value;
    }

    const binding = this.#bindings.get(value.id);

    if (binding === undefined) {
      return value;
    }

    if (binding.kind !== "const") {
      this.#bindings.delete(value.id);
    }

    return binding;
  }
}

function countVarUses(block: IrExpressionInputBlock): Map<number, number> {
  const counts = new Map<number, number>();

  for (const op of block) {
    switch (op.op) {
      case "get":
        countStorageUses(counts, op.source);
        break;
      case "set":
        countStorageUses(counts, op.target);
        countValueUse(counts, op.value);
        break;
      case "set.if":
        countValueUse(counts, op.condition);
        countStorageUses(counts, op.target);
        countValueUse(counts, op.value);
        break;
      case "address":
      case "value.const":
      case "aluFlags.condition":
      case "next":
        break;
      case "flagProducer.condition":
        for (const name of flagProducerConditionInputNames(op)) {
          countValueUse(counts, requiredFlagProducerConditionInput(op, name));
        }
        break;
      case "value.binary":
        countValueUse(counts, op.a);
        countValueUse(counts, op.b);
        break;
      case "value.unary":
        countValueUse(counts, op.value);
        break;
      case "value.select":
        countValueUse(counts, op.condition);
        countValueUse(counts, op.whenTrue);
        countValueUse(counts, op.whenFalse);
        break;
      case "flags.set":
        for (const value of Object.values(op.inputs)) {
          countValueUse(counts, value);
        }
        break;
      case "flags.materialize":
      case "flags.boundary":
        break;
      case "jump":
        countValueUse(counts, op.target);
        break;
      case "conditionalJump":
        countValueUse(counts, op.condition);
        countValueUse(counts, op.taken);
        countValueUse(counts, op.notTaken);
        break;
      case "hostTrap":
        countValueUse(counts, op.vector);
        break;
    }
  }

  return counts;
}

function countStorageUses(counts: Map<number, number>, storage: StorageRef): void {
  if (storage.kind === "mem") {
    countValueUse(counts, storage.address);
  }
}

function countValueUse(counts: Map<number, number>, value: ValueRef): void {
  if (value.kind === "var") {
    counts.set(value.id, remainingUses(counts, value.id) + 1);
  }
}

function opUsesVar(op: IrExpressionInputOp, id: number): boolean {
  switch (op.op) {
    case "get":
      return storageUsesVar(op.source, id);
    case "set":
      return storageUsesVar(op.target, id) || valueUsesVar(op.value, id);
    case "set.if":
      return valueUsesVar(op.condition, id) ||
        storageUsesVar(op.target, id) ||
        valueUsesVar(op.value, id);
    case "address":
      return false;
    case "value.const":
      return false;
    case "aluFlags.condition":
      return false;
    case "flagProducer.condition":
      return flagProducerConditionInputNames(op).some((name) =>
        valueUsesVar(requiredFlagProducerConditionInput(op, name), id)
      );
    case "value.binary":
      return valueUsesVar(op.a, id) || valueUsesVar(op.b, id);
    case "value.unary":
      return valueUsesVar(op.value, id);
    case "value.select":
      return valueUsesVar(op.condition, id) ||
        valueUsesVar(op.whenTrue, id) ||
        valueUsesVar(op.whenFalse, id);
    case "flags.set":
      return Object.values(op.inputs).some((value) => valueUsesVar(value, id));
    case "flags.materialize":
    case "flags.boundary":
    case "next":
      return false;
    case "jump":
      return valueUsesVar(op.target, id);
    case "conditionalJump":
      return valueUsesVar(op.condition, id) ||
        valueUsesVar(op.taken, id) ||
        valueUsesVar(op.notTaken, id);
    case "hostTrap":
      return valueUsesVar(op.vector, id);
  }
}

function valueUsesVar(value: ValueRef, id: number): boolean {
  return value.kind === "var" && value.id === id;
}

function storageUsesVar(storage: StorageRef, id: number): boolean {
  return storage.kind === "mem" && valueUsesVar(storage.address, id);
}

function opWriteStorages(op: IrExpressionInputOp): readonly StorageRef[] {
  switch (op.op) {
    case "set":
    case "set.if":
      return [op.target];
    default:
      return [];
  }
}

function storagesMayAlias(
  write: StorageRef,
  read: StorageRef,
  alias: IrExpressionAliasModel | undefined
): boolean {
  return (alias?.storageMayAlias ?? storageRefsMayOverlap)(write, read);
}

function storageRefsMayOverlap(left: StorageRef, right: StorageRef): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "reg":
      return right.kind === "reg" && left.reg === right.reg;
    case "operand":
      return right.kind === "operand" && left.index === right.index;
    case "mem":
      return true;
  }
}

function conditionalWriteValueVars(block: IrExpressionInputBlock): ReadonlySet<number> {
  const vars = new Set<number>();

  for (const op of block) {
    if (op.op === "set.if" && op.value.kind === "var") {
      vars.add(op.value.id);
    }
  }

  return vars;
}

function remainingUses(useCounts: ReadonlyMap<number, number>, id: number): number {
  return useCounts.get(id) ?? 0;
}
