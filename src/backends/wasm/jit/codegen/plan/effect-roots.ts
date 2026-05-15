import type {
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { EffectKind } from "#backends/wasm/jit/analysis/effect-classifier.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  rootPath,
  type Path,
  type PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import type { JitMaterializationNeed } from "./types.js";
import {
  opView,
  type Timeline
} from "#backends/wasm/jit/analysis/timeline.js";
import type {
  JitExpressionValueUseRoot,
  JitJitValueUseRoot,
  JitValueUsePlacement
} from "./value-uses.js";

export type JitEffectValueRootPurpose =
  | "memoryGuardAddress"
  | "memoryStoreAddress"
  | "memoryStoreValue"
  | "branchCondition"
  | "branchTarget"
  | "controlTarget"
  | "hostTrapVector"
  | "guardFailurePayload"
  | "exitStore";

export type JitEffectExpressionValueRoot = Omit<JitExpressionValueUseRoot, "purpose"> & Readonly<{
  purpose: JitEffectValueRootPurpose;
}>;

export type JitEffectJitValueRoot = Omit<JitJitValueUseRoot, "purpose"> & Readonly<{
  purpose: JitEffectValueRootPurpose;
}>;

export type JitEffectValueRoot =
  | JitEffectExpressionValueRoot
  | JitEffectJitValueRoot;

export type JitEffectRootInstructionInput = Readonly<{
  expressionPaths: PathMap;
  valueTimeline: Timeline;
}>;

export function jitEffectValueRootsForOp(
  instruction: JitEffectRootInstructionInput,
  op: IrExprOp,
  kind: EffectKind,
  placement: JitValueUsePlacement
): readonly JitEffectValueRoot[] {
  const root = rootPath();

  switch (kind) {
    case "memoryGuard":
      return op.op === "memory.guard"
        ? [
            expressionRoot(op.address, root, "memoryGuardAddress"),
            expressionRoot(op.address, root, "guardFailurePayload")
          ]
        : unexpectedExpressionOp(kind, op);
    case "memoryStore":
      return op.op === "set"
        ? [
            ...storageAddressRoots(
              instruction,
              op.target,
              placement.opIndex,
              root,
              "memoryStoreAddress"
            ),
            expressionRoot(op.value, root, "memoryStoreValue")
          ]
        : unexpectedExpressionOp(kind, op);
    case "jump":
      return op.op === "jump"
        ? [expressionRoot(op.target, root, "controlTarget")]
        : unexpectedExpressionOp(kind, op);
    case "branch": {
      if (op.op !== "conditionalJump") {
        return unexpectedExpressionOp(kind, op);
      }

      const branchPaths = instruction.expressionPaths.get(placement.opIndex)!;

      return [
        expressionRoot(op.condition, root, "branchCondition"),
        expressionRoot(op.taken, branchPaths.taken, "branchTarget"),
        expressionRoot(op.notTaken, branchPaths.notTaken, "branchTarget")
      ];
    }
    case "hostTrap":
      return op.op === "hostTrap"
        ? [expressionRoot(op.vector, root, "hostTrapVector")]
        : unexpectedExpressionOp(kind, op);
    case "fallthrough":
    case "producedValue":
      return [];
  }
}

export function jitEffectValueRootForMaterializationNeed(
  need: JitMaterializationNeed
): JitEffectValueRoot {
  return jitValueRoot(need.value, need.path, "exitStore");
}

function storageAddressRoots(
  instruction: JitEffectRootInstructionInput,
  storage: IrStorageExpr,
  opIndex: number,
  path: Path,
  purpose: JitEffectValueRootPurpose
): readonly JitEffectValueRoot[] {
  switch (storage.kind) {
    case "mem":
      return [expressionRoot(storage.address, path, purpose)];
    case "operand": {
      const value = opView(instruction.valueTimeline, opIndex).address(storage);

      return value === undefined
        ? []
        : [jitValueRoot(value, path, purpose)];
    }
    case "reg":
      return [];
  }
}

function expressionRoot(
  value: IrValueExpr,
  path: Path,
  purpose: JitEffectValueRootPurpose
): JitEffectValueRoot {
  return {
    kind: "expression",
    value,
    path,
    purpose
  };
}

function jitValueRoot(
  value: JitValue,
  path: Path,
  purpose: JitEffectValueRootPurpose
): JitEffectValueRoot {
  return {
    kind: "jitValue",
    value,
    path,
    purpose
  };
}

function unexpectedExpressionOp(kind: EffectKind, op: IrExprOp): never {
  throw new Error(`JIT effect ${kind} mapped to expression op ${op.op}`);
}
