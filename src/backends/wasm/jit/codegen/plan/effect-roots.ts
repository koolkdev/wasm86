import type {
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { EffectKind } from "#backends/wasm/jit/analysis/effect-classifier.js";
import {
  rootPath,
  type Path,
  type PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import {
  opView,
  type Timeline
} from "#backends/wasm/jit/analysis/timeline.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type {
  Placement,
  UsePurpose,
  ValueRoot
} from "./value-uses.js";

export type EffectValueRootPurpose = UsePurpose;
export type EffectValueRoot = ValueRoot;

export type EffectRootInstructionInput = Readonly<{
  expressionPaths: PathMap;
  valueTimeline: Timeline;
}>;

export function effectValueRootsForOp(
  instruction: EffectRootInstructionInput,
  op: IrExprOp,
  kind: EffectKind,
  placement: Placement
): readonly EffectValueRoot[] {
  const root = rootPath();

  switch (kind) {
    case "memoryGuard":
      return op.op === "memory.guard"
        ? valueRootsForExpression(instruction, op.address, placement, root, "memoryAddress")
        : unexpectedExpressionOp(kind, op);
    case "memoryStore":
      return op.op === "set"
        ? [
            ...storageAddressRoots(
              instruction,
              op.target,
              placement,
              root,
              "memoryAddress"
            ),
            ...valueRootsForExpression(instruction, op.value, placement, root, "memoryValue")
          ]
        : unexpectedExpressionOp(kind, op);
    case "jump":
      return op.op === "jump"
        ? valueRootsForExpression(instruction, op.target, placement, root, "controlTarget")
        : unexpectedExpressionOp(kind, op);
    case "branch": {
      if (op.op !== "conditionalJump") {
        return unexpectedExpressionOp(kind, op);
      }

      const branchPaths = instruction.expressionPaths.get(placement.opIndex)!;

      return [
        ...valueRootsForExpression(instruction, op.condition, placement, root, "branchCondition"),
        ...valueRootsForExpression(
          instruction,
          op.taken,
          placement,
          branchPaths.taken,
          "branchTarget"
        ),
        ...valueRootsForExpression(
          instruction,
          op.notTaken,
          placement,
          branchPaths.notTaken,
          "branchTarget"
        )
      ];
    }
    case "hostTrap":
      return op.op === "hostTrap"
        ? valueRootsForExpression(instruction, op.vector, placement, root, "trapVector")
        : unexpectedExpressionOp(kind, op);
    case "fallthrough":
    case "producedValue":
      return [];
  }
}

function storageAddressRoots(
  instruction: EffectRootInstructionInput,
  storage: IrStorageExpr,
  placement: Placement,
  path: Path,
  purpose: UsePurpose
): readonly EffectValueRoot[] {
  switch (storage.kind) {
    case "mem":
      return valueRootsForExpression(
        instruction,
        storage.address,
        placement,
        path,
        purpose
      );
    case "operand": {
      const value = opView(instruction.valueTimeline, placement.opIndex).address(storage);

      return value === undefined
        ? []
        : [valueRoot(value, placement, path, purpose)];
    }
    case "reg":
      return [];
  }
}

function valueRootsForExpression(
  instruction: EffectRootInstructionInput,
  value: IrValueExpr,
  placement: Placement,
  path: Path,
  purpose: UsePurpose
): readonly EffectValueRoot[] {
  const jitValue = jitValueForExpression(instruction, value, placement.opIndex);

  return jitValue === undefined
    ? childValueRootsForExpression(instruction, value, placement, path, purpose)
    : [valueRoot(jitValue, placement, path, purpose)];
}

function childValueRootsForExpression(
  instruction: EffectRootInstructionInput,
  value: IrValueExpr,
  placement: Placement,
  path: Path,
  purpose: UsePurpose
): readonly EffectValueRoot[] {
  switch (value.kind) {
    case "source":
      return storageAddressRoots(instruction, value.source, placement, path, purpose);
    case "value.binary":
      return [
        ...valueRootsForExpression(instruction, value.a, placement, path, purpose),
        ...valueRootsForExpression(instruction, value.b, placement, path, purpose)
      ];
    case "value.unary":
      return valueRootsForExpression(instruction, value.value, placement, path, purpose);
    case "value.select":
      return [
        ...valueRootsForExpression(instruction, value.condition, placement, path, purpose),
        ...valueRootsForExpression(instruction, value.whenTrue, placement, path, purpose),
        ...valueRootsForExpression(instruction, value.whenFalse, placement, path, purpose)
      ];
    case "var":
    case "const":
    case "nextEip":
    case "address":
    case "flags.condition":
      return [];
  }
}

function valueRoot(
  value: JitValue,
  at: Placement,
  path: Path,
  purpose: UsePurpose
): EffectValueRoot {
  return {
    value,
    at,
    path,
    purpose
  };
}

function jitValueForExpression(
  instruction: EffectRootInstructionInput,
  value: IrValueExpr,
  opIndex: number
): JitValue | undefined {
  const view = opView(instruction.valueTimeline, opIndex);

  switch (value.kind) {
    case "var":
    case "const":
    case "nextEip":
      return view.ref(value);
    case "source":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return view.expression(value);
  }
}

function unexpectedExpressionOp(kind: EffectKind, op: IrExprOp): never {
  throw new Error(`JIT effect ${kind} mapped to expression op ${op.op}`);
}
