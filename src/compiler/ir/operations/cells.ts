import type { CellRef } from "#compiler/ir/cell.js";
import type { ValueId, ValueInput } from "#compiler/ir/values/types.js";
import {
  operationResult,
  OperationBase,
  type OperationFactory,
  type OperationOutputAllocator,
  type OperationResult
} from "./definition.js";

type CellReadArgs = Readonly<{
  cell: CellRef;
}>;

export class CellReadOperation extends OperationBase {
  static readonly kind = "cell.read";
  readonly kind = CellReadOperation.kind;
  declare readonly inputs: readonly [];
  declare readonly results: readonly [OperationResult];

  private constructor(
    readonly cell: CellRef,
    result: OperationResult,
    output: ValueId
  ) {
    super({
      inputs: [],
      results: [result],
      outputs: [output],
      directEffects: { reads: [{ space: "cell", cell }], writes: [] }
    });
  }

  static create(
    { cell }: CellReadArgs,
    allocateOutput: OperationOutputAllocator
  ): CellReadOperation {
    const result = operationResult(cell.type);

    return new CellReadOperation(cell, result, allocateOutput(result));
  }
}

export const cellRead = CellReadOperation satisfies OperationFactory<
  CellReadArgs,
  CellReadOperation
>;

export type CellWriteInitialization = "seed" | "update";

type CellWriteArgs = Readonly<{
  cell: CellRef;
  value: ValueId;
  initialization: CellWriteInitialization;
}>;

export class CellWriteOperation extends OperationBase {
  static readonly kind = "cell.write";
  readonly kind = CellWriteOperation.kind;
  declare readonly inputs: readonly [ValueInput];
  declare readonly results: readonly [];

  private constructor(
    readonly cell: CellRef,
    readonly value: ValueId,
    readonly initialization: CellWriteInitialization
  ) {
    const inputs: readonly [ValueInput] = [{ value, type: cell.type }];

    super({
      inputs,
      results: [],
      outputs: [],
      directEffects: { reads: [], writes: [{ space: "cell", cell }] }
    });
  }

  static create({
    cell,
    value,
    initialization
  }: CellWriteArgs): CellWriteOperation {
    return new CellWriteOperation(cell, value, initialization);
  }
}

export const cellWrite = CellWriteOperation satisfies OperationFactory<
  CellWriteArgs,
  CellWriteOperation
>;
