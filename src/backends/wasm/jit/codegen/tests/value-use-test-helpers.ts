import type {
  IrExprBlock,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import {
  branchPath,
  rootPath,
  type BranchPaths,
  type Path,
  type PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import type { Timeline } from "#backends/wasm/jit/analysis/timeline-types.js";
import { jitExpressionOpEpochs } from "#backends/wasm/jit/codegen/plan/epochs.js";
import {
  expandRootUse,
  type ValueRoot,
  type ValueUse
} from "#backends/wasm/jit/codegen/plan/value-uses.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import { rootExpressionPaths } from "./path-test-helpers.js";

export type TestValueRoot = Omit<ValueRoot, "at">;

export function valueUsesForExpressionBlock(input: Readonly<{
  expressionBlock: IrExprBlock;
  valueTimeline: Timeline;
  expressionPaths?: PathMap;
  extraUses?: ReadonlyMap<number, readonly TestValueRoot[]>;
  instructionIndex?: number;
  startEpoch?: number;
}>): readonly ValueUse[] {
  const expressionPaths = input.expressionPaths ?? rootExpressionPaths(input.expressionBlock);
  const instructionIndex = input.instructionIndex ?? 0;
  const opEpochs = jitExpressionOpEpochs({
    expressionBlock: input.expressionBlock,
    valueTimeline: input.valueTimeline
  }, input.startEpoch ?? 0);
  const roots: ValueRoot[] = [];

  for (let opIndex = 0; opIndex < input.expressionBlock.length; opIndex += 1) {
    const op = input.expressionBlock[opIndex];

    if (op === undefined) {
      throw new Error(`missing test expression op: ${opIndex}`);
    }

    const at = {
      instructionIndex,
      opIndex,
      epoch: opEpochs[opIndex]!
    };
    roots.push(...valueRootsForTestExpressionOp({
      expressionPaths,
      valueTimeline: input.valueTimeline
    }, op, at));

    roots.push(...(input.extraUses?.get(opIndex) ?? []).map((root) => ({
      ...root,
      at
    })));
  }

  return roots.flatMap(expandRootUse);
}

export function branchExpressionPaths(
  expressionBlock: IrExprBlock,
  instructionIndex = 0
): PathMap {
  const paths = new Map<number, BranchPaths>();

  for (let opIndex = 0; opIndex < expressionBlock.length; opIndex += 1) {
    if (expressionBlock[opIndex]?.op === "conditionalJump") {
      paths.set(opIndex, {
        taken: branchPath(instructionIndex, opIndex, "taken"),
        notTaken: branchPath(instructionIndex, opIndex, "notTaken")
      });
    }
  }

  return paths;
}

function valueRootsForTestExpressionOp(
  input: Readonly<{
    expressionPaths: PathMap;
    valueTimeline: Timeline;
  }>,
  op: IrExprBlock[number],
  at: ValueRoot["at"]
): readonly ValueRoot[] {
  const root = rootPath();

  switch (op.op) {
    case "memory.guard":
      return valueRootsForExpression(input, op.address, at, root, "memoryAddress");
    case "set":
      return op.target.kind === "mem"
        ? [
            ...valueRootsForExpression(input, op.target.address, at, root, "memoryAddress"),
            ...valueRootsForExpression(input, op.value, at, root, "memoryValue")
          ]
        : [];
    case "jump":
      return valueRootsForExpression(input, op.target, at, root, "controlTarget");
    case "conditionalJump": {
      const branchPaths = input.expressionPaths.get(at.opIndex);

      if (branchPaths === undefined) {
        throw new Error(`missing test branch paths for op ${at.opIndex}`);
      }

      return [
        ...valueRootsForExpression(input, op.condition, at, root, "branchCondition"),
        ...valueRootsForExpression(input, op.taken, at, branchPaths.taken, "branchTarget"),
        ...valueRootsForExpression(input, op.notTaken, at, branchPaths.notTaken, "branchTarget")
      ];
    }
    case "hostTrap":
      return valueRootsForExpression(input, op.vector, at, root, "trapVector");
    case "let32":
    case "next":
    case "flags.set":
      return [];
  }
}

function valueRootsForExpression(
  input: Readonly<{
    valueTimeline: Timeline;
  }>,
  value: IrValueExpr,
  at: ValueRoot["at"],
  path: Path,
  purpose: ValueRoot["purpose"]
): readonly ValueRoot[] {
  const jitValue = jitValueForExpression(input, value, at.opIndex);

  return jitValue === undefined
    ? childValueRootsForExpression(input, value, at, path, purpose)
    : [{
        value: jitValue,
        at,
        path,
        purpose
      }];
}

function childValueRootsForExpression(
  input: Readonly<{
    valueTimeline: Timeline;
  }>,
  value: IrValueExpr,
  at: ValueRoot["at"],
  path: Path,
  purpose: ValueRoot["purpose"]
): readonly ValueRoot[] {
  switch (value.kind) {
    case "source":
      return storageAddressRoots(input, value.source, at, path, purpose);
    case "value.binary":
      return [
        ...valueRootsForExpression(input, value.a, at, path, purpose),
        ...valueRootsForExpression(input, value.b, at, path, purpose)
      ];
    case "value.unary":
      return valueRootsForExpression(input, value.value, at, path, purpose);
    case "value.select":
      return [
        ...valueRootsForExpression(input, value.condition, at, path, purpose),
        ...valueRootsForExpression(input, value.whenTrue, at, path, purpose),
        ...valueRootsForExpression(input, value.whenFalse, at, path, purpose)
      ];
    case "var":
    case "const":
    case "nextEip":
    case "address":
    case "flags.condition":
      return [];
  }
}

function storageAddressRoots(
  input: Readonly<{
    valueTimeline: Timeline;
  }>,
  storage: IrStorageExpr,
  at: ValueRoot["at"],
  path: Path,
  purpose: ValueRoot["purpose"]
): readonly ValueRoot[] {
  switch (storage.kind) {
    case "mem":
      return valueRootsForExpression(input, storage.address, at, path, purpose);
    case "operand":
    case "reg": {
      const view = input.valueTimeline.viewAt(at.opIndex);

      return view.hasStorageAddress(storage)
        ? [{ value: view.storageAddress(storage), at, path, purpose }]
        : [];
    }
  }
}

function jitValueForExpression(
  input: Readonly<{
    valueTimeline: Timeline;
  }>,
  value: IrValueExpr,
  opIndex: number
): JitValue | undefined {
  const view = input.valueTimeline.viewAt(opIndex);

  return view.hasValue(value) ? view.value(value) : undefined;
}
