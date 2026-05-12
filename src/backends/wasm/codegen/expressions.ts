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
import {
  irOpStorageWrites,
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

export type IrExprOp =
  | Readonly<{ op: "let32"; dst: VarRef; value: IrValueExpr }>
  | IrSetExprOp
  | IrFlagSetOp
  | Readonly<{ op: "next" }>
  | Readonly<{ op: "jump"; target: IrValueExpr }>
  | Readonly<{ op: "conditionalJump"; condition: IrValueExpr; taken: IrValueExpr; notTaken: IrValueExpr }>
  | Readonly<{ op: "hostTrap"; vector: IrValueExpr }>;

export type IrExprBlock = readonly IrExprOp[];

export type IrExpressionSourcePlacementKind =
  // The source op emitted this expression op directly.
  | "emittedOp"
  // The source op's value was omitted or inlined, and is consumed here.
  | "valueUse";

export type IrExpressionSourcePlacement = Readonly<{
  expressionOpIndex: number;
  kind: IrExpressionSourcePlacementKind;
}>;

export type IrExpressionSourceMap = Readonly<{
  placementsBySourceOpIndex: ReadonlyMap<number, readonly IrExpressionSourcePlacement[]>;
}>;

export type IrExpressionBuildResult = Readonly<{
  expressionBlock: IrExprBlock;
  sourceMap: IrExpressionSourceMap;
}>;

export type IrExpressionSetInputOp = Extract<IrOp, { op: "set" }>;

export type IrExpressionInputOp =
  | Exclude<IrOp, Extract<IrOp, { op: "set" }>>
  | IrExpressionSetInputOp;
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
  return buildIrExpressionBlockWithSourceMap(block, options).expressionBlock;
}

export function buildIrExpressionBlockWithSourceMap(
  block: IrExpressionInputBlock,
  options: IrExpressionOptions = {}
): IrExpressionBuildResult {
  const builder = new ExpressionBuilder(block, options);

  return builder.build();
}

type ExpressionBinding = Readonly<{
  value: IrValueExpr;
  sourceOpIndexes: readonly number[];
}>;

type ExpressionValueResult = Readonly<{
  value: IrValueExpr;
  sourceOpIndexes: readonly number[];
}>;

type ExpressionStorageResult = Readonly<{
  storage: IrStorageExpr;
  sourceOpIndexes: readonly number[];
}>;

class ExpressionBuilder {
  readonly #bindings = new Map<number, ExpressionBinding>();
  readonly #ops: IrExprOp[] = [];
  readonly #placementsBySourceOpIndex = new Map<number, IrExpressionSourcePlacement[]>();
  readonly #useCounts: ReadonlyMap<number, number>;
  #sourceOpIndex = -1;

  constructor(
    readonly block: IrExpressionInputBlock,
    readonly options: IrExpressionOptions
  ) {
    this.#useCounts = countVarUses(block);
  }

  build(): IrExpressionBuildResult {
    for (let opIndex = 0; opIndex < this.block.length; opIndex += 1) {
      const op = this.block[opIndex];

      if (op === undefined) {
        throw new Error(`missing IR expression input op: ${opIndex}`);
      }

      this.#sourceOpIndex = opIndex;

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
            source.sourceOpIndexes,
            this.options.canInlineGet?.(op.source) === true &&
              !this.#inlineGetWouldCrossAliasBarrier(op.dst, op.source, opIndex)
          );
          break;
        }
        case "set":
          this.#pushOp(...this.#setExpr(op));
          break;
        case "address":
          this.#defineValue(op.dst, { kind: "address", operand: op.operand }, [], true);
          break;
        case "value.const":
          this.#bindings.set(op.dst.id, {
            value: { kind: "const", type: op.type, value: op.value },
            sourceOpIndexes: [opIndex]
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
          }, [...a.sourceOpIndexes, ...b.sourceOpIndexes], true);
          break;
        }
        case "value.unary": {
          const value = this.#valueExpr(op.value);

          this.#defineValue(op.dst, {
            kind: "value.unary",
            type: op.type,
            operator: op.operator,
            value: value.value
          }, value.sourceOpIndexes, true);
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
          }, [
            ...condition.sourceOpIndexes,
            ...whenTrue.sourceOpIndexes,
            ...whenFalse.sourceOpIndexes
          ], true);
          break;
        }
        case "flags.condition":
          this.#defineValue(op.dst, { kind: "flags.condition", cc: op.cc }, [], false);
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
          }, inputs.flatMap(({ value }) => value.sourceOpIndexes));
          break;
        }
        case "next":
          this.#pushOp(op, []);
          break;
        case "jump": {
          const target = this.#valueExpr(op.target);

          this.#pushOp({ op: "jump", target: target.value }, target.sourceOpIndexes);
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
          }, [
            ...condition.sourceOpIndexes,
            ...taken.sourceOpIndexes,
            ...notTaken.sourceOpIndexes
          ]);
          break;
        }
        case "hostTrap": {
          const vector = this.#valueExpr(op.vector);

          this.#pushOp({ op: "hostTrap", vector: vector.value }, vector.sourceOpIndexes);
          break;
        }
      }
    }

    return {
      expressionBlock: this.#ops,
      sourceMap: {
        placementsBySourceOpIndex: this.#placementsBySourceOpIndex
      }
    };
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

  #defineValue(
    dst: VarRef,
    value: IrValueExpr,
    sourceOpIndexes: readonly number[],
    inlineable: boolean
  ): void {
    const origins = uniqueSourceOpIndexes([...sourceOpIndexes, this.#sourceOpIndex]);

    if (inlineable && remainingUses(this.#useCounts, dst.id) <= 1) {
      this.#bindings.set(dst.id, { value, sourceOpIndexes: origins });
      return;
    }

    this.#pushOp({ op: "let32", dst, value }, sourceOpIndexes);
  }

  #setExpr(op: Extract<IrExpressionInputOp, { op: "set" }>): readonly [IrSetExprOp, readonly number[]] {
    const target = this.#storageExpr(op.target);
    const value = this.#valueExpr(op.value);
    const expr: IrSetExprOp = {
      op: "set",
      target: target.storage,
      value: value.value,
      accessWidth: op.accessWidth ?? 32
    };
    const origins = [...target.sourceOpIndexes, ...value.sourceOpIndexes];

    return [expr, origins];
  }

  #materializedValue(value: ValueRef): Readonly<{ value: ValueRef; sourceOpIndexes: readonly number[] }> {
    const expr = this.#valueExpr(value);
    const exprValue = expr.value;

    if (exprValue.kind === "var" || exprValue.kind === "const" || exprValue.kind === "nextEip") {
      return { value: exprValue, sourceOpIndexes: expr.sourceOpIndexes };
    }

    const materialized = value.kind === "var" ? value : undefined;

    if (materialized === undefined) {
      throw new Error("cannot materialize non-var IR expression input");
    }

    this.#pushOp({ op: "let32", dst: materialized, value: expr.value }, expr.sourceOpIndexes);
    this.#bindings.delete(materialized.id);
    return { value: materialized, sourceOpIndexes: [] };
  }

  #storageExpr(storage: StorageRef): ExpressionStorageResult {
    switch (storage.kind) {
      case "operand":
      case "reg":
        return { storage, sourceOpIndexes: [] };
      case "mem": {
        const address = this.#valueExpr(storage.address);

        return {
          storage: { kind: "mem", address: address.value },
          sourceOpIndexes: address.sourceOpIndexes
        };
      }
    }
  }

  #valueExpr(value: ValueRef): ExpressionValueResult {
    if (value.kind !== "var") {
      return { value, sourceOpIndexes: [] };
    }

    const binding = this.#bindings.get(value.id);

    if (binding === undefined) {
      return { value, sourceOpIndexes: [] };
    }

    if (binding.value.kind !== "const") {
      this.#bindings.delete(value.id);
    }

    return binding;
  }

  #pushOp(op: IrExprOp, sourceOpIndexes: readonly number[]): void {
    const expressionOpIndex = this.#ops.length;

    this.#ops.push(op);
    this.#recordPlacement(this.#sourceOpIndex, expressionOpIndex, "emittedOp");

    for (const sourceOpIndex of uniqueSourceOpIndexes(sourceOpIndexes)) {
      this.#recordPlacement(sourceOpIndex, expressionOpIndex, "valueUse");
    }
  }

  #recordPlacement(
    sourceOpIndex: number,
    expressionOpIndex: number,
    kind: IrExpressionSourcePlacementKind
  ): void {
    const placements = this.#placementsBySourceOpIndex.get(sourceOpIndex) ?? [];

    if (!placements.some((placement) =>
      placement.expressionOpIndex === expressionOpIndex && placement.kind === kind
    )) {
      placements.push({ expressionOpIndex, kind });
    }

    this.#placementsBySourceOpIndex.set(sourceOpIndex, placements);
  }
}

function uniqueSourceOpIndexes(indexes: readonly number[]): readonly number[] {
  const unique: number[] = [];

  for (const index of indexes) {
    if (index >= 0 && !unique.includes(index)) {
      unique.push(index);
    }
  }

  return unique;
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

function opUsesVar(op: IrExpressionInputOp, id: number): boolean {
  let found = false;

  visitIrOpValueRefs(op, (value) => {
    found ||= value.kind === "var" && value.id === id;
  });

  return found;
}

function opWriteStorages(op: IrExpressionInputOp): readonly StorageRef[] {
  return irOpStorageWrites(op);
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

function remainingUses(useCounts: ReadonlyMap<number, number>, id: number): number {
  return useCounts.get(id) ?? 0;
}
