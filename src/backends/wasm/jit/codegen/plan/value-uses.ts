import {
  rootPath,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import { valueChildren } from "#backends/wasm/jit/ir/values/walk.js";
import type { PlannedExit } from "./exit-stores.js";
import type {
  Effect,
  EffectPlacement,
} from "./effect-types.js";

export type Placement = EffectPlacement;

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
  effects: readonly Effect[];
}>;

export function collectValueUses(input: ValueUseInput): readonly ValueUse[] {
  const roots = [
    ...rootsForEffects(input.effects),
    ...rootsForExitStores(input.effects)
  ];

  return roots.flatMap(expandRootUse);
}

export function rootsForEffects(
  effects: readonly Effect[]
): readonly ValueRoot[] {
  return effects.flatMap(rootsForEffect);
}

export function rootsForExitStores(
  effects: readonly Effect[]
): readonly ValueRoot[] {
  return effects.flatMap((effect) =>
    exitsForEffect(effect).flatMap((exit) =>
      rootsForExitStore(exit, effect.at)
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

function valueRoot(
  value: JitValue,
  at: Placement,
  path: Path,
  purpose: UsePurpose
): ValueRoot {
  return {
    value,
    at,
    path,
    purpose
  };
}

function rootsForEffect(effect: Effect): readonly ValueRoot[] {
  switch (effect.kind) {
    case "memoryGuard":
      return [
        valueRoot(effect.address, effect.at, rootPath(), "memoryAddress")
      ];
    case "memoryStore":
      return [
        valueRoot(effect.address, effect.at, effectPath(effect), "memoryAddress"),
        valueRoot(effect.value, effect.at, effectPath(effect), "memoryValue")
      ];
    case "jump":
      return [
        valueRoot(effect.target, effect.at, effect.exit.path, "controlTarget")
      ];
    case "branch":
      return [
        valueRoot(effect.condition, effect.at, effectPath(effect), "branchCondition"),
        valueRoot(effect.takenTarget, effect.at, effect.taken.path, "branchTarget"),
        valueRoot(effect.notTakenTarget, effect.at, effect.notTaken.path, "branchTarget")
      ];
    case "hostTrap":
      return [
        valueRoot(effect.vector, effect.at, rootPath(), "trapVector")
      ];
    case "producedValue":
    case "fallthrough":
      return [];
  }
}

function effectPath(effect: Effect): Path {
  switch (effect.kind) {
    case "memoryGuard":
      return rootPath();
    case "jump":
      return effect.exit.path;
    case "branch":
    case "memoryStore":
    case "producedValue":
    case "hostTrap":
    case "fallthrough":
      return rootPath();
  }
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

function exitsForEffect(effect: Effect): readonly PlannedExit[] {
  switch (effect.kind) {
    case "memoryGuard":
      return [effect.exit];
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
