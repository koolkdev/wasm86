import {
  type Path
} from "#backends/wasm/jit/analysis/paths.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import { valueChildren } from "#backends/wasm/jit/ir/values/walk.js";
import type { PlannedExit } from "./exit-stores.js";

export type Placement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  epoch: number;
}>;

export type UsePurpose =
  | "memoryAddress"
  | "memoryValue"
  | "branchCondition"
  | "branchTarget"
  | "controlTarget"
  | "trapVector"
  | "exitStore"
  | "producedValue";

export type ValueRoot = Readonly<{
  value: JitValue;
  at: Placement;
  path: Path;
  purpose: UsePurpose;
  exitId?: string;
}>;

export type ValueUse = Readonly<{
  value: JitValue;
  at: Placement;
  path: Path;
  purpose: UsePurpose;
  root: JitValue;
  ancestors: readonly JitValue[];
  exitId?: string;
}>;

export type ValueUseInput = Readonly<{
  effects: readonly ValueUseEffect[];
}>;

export type ValueUseEffect = Readonly<{
  placement: Placement;
  valueRoots: readonly ValueRoot[];
}> & (
  | Readonly<{ kind: "memoryGuard"; faultExit: PlannedExit }>
  | Readonly<{ kind: "memoryStore" }>
  | Readonly<{ kind: "producedValue" }>
  | Readonly<{ kind: "jump"; exit: PlannedExit }>
  | Readonly<{ kind: "branch"; taken: PlannedExit; notTaken: PlannedExit }>
  | Readonly<{ kind: "hostTrap"; exit: PlannedExit }>
  | Readonly<{ kind: "fallthrough"; exit: PlannedExit }>
);

export function collectValueUses(input: ValueUseInput): readonly ValueUse[] {
  const roots = [
    ...rootsForEffects(input.effects),
    ...rootsForExitStores(input.effects)
  ];

  return roots.flatMap(expandRootUse);
}

export function rootsForEffects(
  effects: readonly ValueUseEffect[]
): readonly ValueRoot[] {
  return effects.flatMap((effect) => effect.valueRoots);
}

export function rootsForExitStores(
  effects: readonly ValueUseEffect[]
): readonly ValueRoot[] {
  return effects.flatMap((effect) =>
    exitsForEffect(effect).flatMap((exit) =>
      rootsForExitStore(exit, effect.placement)
    )
  );
}

export function expandRootUse(root: ValueRoot): readonly ValueUse[] {
  const value = simplifyValue(root.value);

  return usesForValue(root, value, value, []);
}

function rootsForExitStore(
  exit: PlannedExit,
  at: Placement
): readonly ValueRoot[] {
  return exit.stores.map((store) => ({
    value: store.value,
    at,
    path: exit.path,
    purpose: "exitStore",
    exitId: exit.id
  }));
}

function usesForValue(
  root: ValueRoot,
  value: JitValue,
  rootValue: JitValue,
  ancestors: readonly JitValue[]
): readonly ValueUse[] {
  const simplified = simplifyValue(value);
  const baseUse = {
    value: simplified,
    at: root.at,
    path: root.path,
    purpose: root.purpose,
    root: rootValue,
    ancestors
  };
  const use: ValueUse = root.exitId === undefined
    ? baseUse
    : {
        ...baseUse,
        exitId: root.exitId
      };
  const childAncestors = [...ancestors, simplified];

  return [
    use,
    ...valueChildren(simplified).flatMap((child) =>
      usesForValue(root, child, rootValue, childAncestors)
    )
  ];
}

function exitsForEffect(effect: ValueUseEffect): readonly PlannedExit[] {
  switch (effect.kind) {
    case "memoryGuard":
      return [effect.faultExit];
    case "jump":
    case "hostTrap":
    case "fallthrough":
      return [effect.exit];
    case "branch":
      return [effect.taken, effect.notTaken];
    case "memoryStore":
    case "producedValue":
      return [];
  }
}
