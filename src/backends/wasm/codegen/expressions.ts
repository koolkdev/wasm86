import type {
  ConditionCode,
  IrBinaryOperator,
  IrFlagSetOp,
  IrMemoryAccessKind,
  OperandRef,
  RegRef,
  IrOp,
  IrUnaryOperator,
  IrValueType,
  StorageRef,
  ValueRef,
  VarRef
} from "#x86/ir/model/types.js";
import {
  visitIrOpValueRefs
} from "#x86/ir/model/op-semantics.js";
import type { OperandWidth } from "#x86/isa/types.js";

export type IrStorageExpr =
  | OperandRef
  | RegRef
  | Readonly<{ kind: "mem"; address: IrValueExpr }>;

export type IrValueExpr =
  | ValueRef
  | Readonly<{ kind: "source"; source: IrStorageExpr; accessWidth: OperandWidth; signed?: boolean }>
  | Readonly<{ kind: "address"; operand: OperandRef }>
  | Readonly<{ kind: "flags.condition"; cc: ConditionCode }>
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
}>;

export type IrMemoryGuardExprOp = Readonly<{
  op: "memory.guard";
  address: IrValueExpr;
  byteLength: number;
  access: IrMemoryAccessKind;
}>;

export type IrExprOp =
  | Readonly<{ op: "let32"; dst: VarRef; value: IrValueExpr }>
  | IrSetExprOp
  | IrMemoryGuardExprOp
  | IrFlagSetOp
  | Readonly<{ op: "next" }>
  | Readonly<{ op: "jump"; target: IrValueExpr }>
  | Readonly<{ op: "conditionalJump"; condition: IrValueExpr; taken: IrValueExpr; notTaken: IrValueExpr }>
  | Readonly<{ op: "hostTrap"; vector: IrValueExpr }>;

export type IrExprBlock = readonly IrExprOp[];

export type IrExpressionSetInputOp = Extract<IrOp, { op: "set" }>;

export type IrExpressionInputOp =
  | Exclude<IrOp, Extract<IrOp, { op: "set" }>>
  | IrExpressionSetInputOp;
export type IrExpressionInputBlock = readonly IrExpressionInputOp[];

export function buildIrExpressionBlock(block: IrExpressionInputBlock): IrExprBlock {
  const builder = new ExpressionBuilder(block);

  return builder.build();
}

type ExpressionBinding = Readonly<{
  value: IrValueExpr;
}>;

type ExpressionValueResult = Readonly<{
  value: IrValueExpr;
}>;

type ExpressionStorageResult = Readonly<{
  storage: IrStorageExpr;
}>;

class ExpressionBuilder {
  readonly #bindings = new Map<number, ExpressionBinding>();
  readonly #ops: IrExprOp[] = [];
  readonly #useCounts: ReadonlyMap<number, number>;

  constructor(
    readonly block: IrExpressionInputBlock
  ) {
    this.#useCounts = countVarUses(block);
  }

  build(): IrExprBlock {
    for (let opIndex = 0; opIndex < this.block.length; opIndex += 1) {
      const op = this.block[opIndex];

      if (op === undefined) {
        throw new Error(`missing IR expression input op: ${opIndex}`);
      }

      switch (op.op) {
        case "get": {
          const source = this.#storageExpr(op.source);

          this.#defineValue(
            op.dst,
            {
              kind: "source",
              source: source.storage,
              accessWidth: op.accessWidth ?? 32,
              ...(op.signed === true ? { signed: true } : {})
            },
            false
          );
          break;
        }
        case "set":
          this.#pushOp(this.#setExpr(op));
          break;
        case "memory.guard": {
          const address = this.#valueExpr(op.address);

          this.#pushOp({
            op: "memory.guard",
            address: address.value,
            byteLength: op.byteLength,
            access: op.access
          });
          break;
        }
        case "address":
          this.#defineValue(op.dst, { kind: "address", operand: op.operand }, true);
          break;
        case "value.const":
          this.#bindings.set(op.dst.id, {
            value: { kind: "const", type: op.type, value: op.value }
          });
          break;
        case "value.binary": {
          const a = this.#valueExpr(op.a);
          const b = this.#valueExpr(op.b);

          this.#defineValue(op.dst, {
            kind: "value.binary",
            type: op.type,
            operator: op.operator,
            a: a.value,
            b: b.value
          }, true);
          break;
        }
        case "value.unary": {
          const value = this.#valueExpr(op.value);

          this.#defineValue(op.dst, {
            kind: "value.unary",
            type: op.type,
            operator: op.operator,
            value: value.value
          }, true);
          break;
        }
        case "value.select": {
          const condition = this.#valueExpr(op.condition);
          const whenTrue = this.#valueExpr(op.whenTrue);
          const whenFalse = this.#valueExpr(op.whenFalse);

          this.#defineValue(op.dst, {
            kind: "value.select",
            type: op.type,
            condition: condition.value,
            whenTrue: whenTrue.value,
            whenFalse: whenFalse.value
          }, true);
          break;
        }
        case "flags.condition":
          this.#defineValue(op.dst, { kind: "flags.condition", cc: op.cc }, false);
          break;
        case "flags.set": {
          const inputs = Object.entries(op.inputs).map(([name, value]) => ({
            name,
            value: this.#materializedValue(value)
          }));

          this.#pushOp({
            op: "flags.set",
            producer: op.producer,
            ...(op.width === undefined ? {} : { width: op.width }),
            writtenMask: op.writtenMask,
            undefMask: op.undefMask,
            inputs: Object.fromEntries(
              inputs.map(({ name, value }) => [name, value.value])
            )
          });
          break;
        }
        case "next":
          this.#pushOp(op);
          break;
        case "jump": {
          const target = this.#valueExpr(op.target);

          this.#pushOp({ op: "jump", target: target.value });
          break;
        }
        case "conditionalJump": {
          const condition = this.#valueExpr(op.condition);
          const taken = this.#valueExpr(op.taken);
          const notTaken = this.#valueExpr(op.notTaken);

          this.#pushOp({
            op: "conditionalJump",
            condition: condition.value,
            taken: taken.value,
            notTaken: notTaken.value
          });
          break;
        }
        case "hostTrap": {
          const vector = this.#valueExpr(op.vector);

          this.#pushOp({ op: "hostTrap", vector: vector.value });
          break;
        }
      }
    }

    return this.#ops;
  }

  #defineValue(
    dst: VarRef,
    value: IrValueExpr,
    inlineable: boolean
  ): void {
    if (inlineable && (remainingUses(this.#useCounts, dst.id) <= 1 || value.kind === "address")) {
      this.#bindings.set(dst.id, { value });
      return;
    }

    this.#pushOp({ op: "let32", dst, value });
  }

  #setExpr(op: Extract<IrExpressionInputOp, { op: "set" }>): IrSetExprOp {
    const target = this.#storageExpr(op.target);
    const value = this.#valueExpr(op.value);

    return {
      op: "set",
      target: target.storage,
      value: value.value,
      accessWidth: op.accessWidth ?? 32
    };
  }

  #materializedValue(value: ValueRef): Readonly<{ value: ValueRef }> {
    const expr = this.#valueExpr(value);
    const exprValue = expr.value;

    if (exprValue.kind === "var" || exprValue.kind === "const" || exprValue.kind === "nextEip") {
      return { value: exprValue };
    }

    const materialized = value.kind === "var" ? value : undefined;

    if (materialized === undefined) {
      throw new Error("cannot materialize non-var IR expression input");
    }

    this.#pushOp({ op: "let32", dst: materialized, value: expr.value });
    this.#bindings.delete(materialized.id);
    return { value: materialized };
  }

  #storageExpr(storage: StorageRef): ExpressionStorageResult {
    switch (storage.kind) {
      case "operand":
      case "reg":
        return { storage };
      case "mem": {
        const address = this.#valueExpr(storage.address);

        return {
          storage: { kind: "mem", address: address.value }
        };
      }
    }
  }

  #valueExpr(value: ValueRef): ExpressionValueResult {
    if (value.kind !== "var") {
      return { value };
    }

    const binding = this.#bindings.get(value.id);

    if (binding === undefined) {
      return { value };
    }

    if (binding.value.kind !== "const" && binding.value.kind !== "address") {
      this.#bindings.delete(value.id);
    }

    return binding;
  }

  #pushOp(op: IrExprOp): void {
    this.#ops.push(op);
  }
}

function countVarUses(block: IrExpressionInputBlock): Map<number, number> {
  const counts = new Map<number, number>();

  for (const op of block) {
    visitIrOpValueRefs(op, (value) => {
      if (value.kind === "var") {
        counts.set(value.id, remainingUses(counts, value.id) + 1);
      }
    });
  }

  return counts;
}

function remainingUses(useCounts: ReadonlyMap<number, number>, id: number): number {
  return useCounts.get(id) ?? 0;
}
