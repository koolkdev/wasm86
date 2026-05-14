import type {
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { JitOrderedEffectKind } from "#backends/wasm/jit/ir/effect-primitives.js";
import type { JitValue } from "#backends/wasm/jit/ir/value-types.js";
import {
  rootValuePathScope,
  type JitControlPathScopesMap,
  type JitValuePathScope
} from "./control-paths.js";
import type { JitMaterializationNeed } from "./types.js";
import {
  jitTimelineEffectiveAddressValueAt,
  type JitInstructionValueTimeline
} from "./value-timeline.js";
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
  expressionPathScopes: JitControlPathScopesMap;
  valueTimeline: JitInstructionValueTimeline;
}>;

export function jitEffectValueRootsForOp(
  instruction: JitEffectRootInstructionInput,
  op: IrExprOp,
  kind: JitOrderedEffectKind,
  placement: JitValueUsePlacement
): readonly JitEffectValueRoot[] {
  const root = rootValuePathScope();

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
    case "controlTransfer":
      switch (op.op) {
        case "jump":
          return [expressionRoot(op.target, root, "controlTarget")];
        case "conditionalJump": {
          const branchPathScopes = instruction.expressionPathScopes.get(placement.opIndex)!;

          return [
            expressionRoot(op.condition, root, "branchCondition"),
            expressionRoot(op.taken, branchPathScopes.taken, "branchTarget"),
            expressionRoot(op.notTaken, branchPathScopes.notTaken, "branchTarget")
          ];
        }
        default:
          return unexpectedExpressionOp(kind, op);
      }
    case "hostTrap":
      return op.op === "hostTrap"
        ? [expressionRoot(op.vector, root, "hostTrapVector")]
        : unexpectedExpressionOp(kind, op);
    case "exitEdge":
    case "producedValueDefinition":
      return [];
  }
}

export function jitEffectValueRootForMaterializationNeed(
  need: JitMaterializationNeed
): JitEffectValueRoot {
  return jitValueRoot(need.value, need.pathScope, "exitStore");
}

function storageAddressRoots(
  instruction: JitEffectRootInstructionInput,
  storage: IrStorageExpr,
  opIndex: number,
  pathScope: JitValuePathScope,
  purpose: JitEffectValueRootPurpose
): readonly JitEffectValueRoot[] {
  switch (storage.kind) {
    case "mem":
      return [expressionRoot(storage.address, pathScope, purpose)];
    case "operand": {
      const value = jitTimelineEffectiveAddressValueAt(
        instruction.valueTimeline,
        opIndex,
        storage
      );

      return value === undefined
        ? []
        : [jitValueRoot(value, pathScope, purpose)];
    }
    case "reg":
      return [];
  }
}

function expressionRoot(
  value: IrValueExpr,
  pathScope: JitValuePathScope,
  purpose: JitEffectValueRootPurpose
): JitEffectValueRoot {
  return {
    kind: "expression",
    value,
    pathScope,
    purpose
  };
}

function jitValueRoot(
  value: JitValue,
  pathScope: JitValuePathScope,
  purpose: JitEffectValueRootPurpose
): JitEffectValueRoot {
  return {
    kind: "jitValue",
    value,
    pathScope,
    purpose
  };
}

function unexpectedExpressionOp(kind: JitOrderedEffectKind, op: IrExprOp): never {
  throw new Error(`JIT effect ${kind} mapped to expression op ${op.op}`);
}
