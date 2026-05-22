import {
  rootPath,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type {
  JitLoadResultValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import { valueChildren } from "#backends/wasm/jit/ir/values/walk.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import type { PlannedExit } from "./types.js";
import type {
  Placement,
  BlockScheduleEntry,
  MemoryLoadValueEntry,
  RuntimeEntry,
} from "./schedule-types.js";

export type UsePurpose =
  | "memoryAddress"
  | "memoryValue"
  | "branchCondition"
  | "branchTarget"
  | "controlTarget"
  | "trapVector"
  | "exitStore";

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
  schedule: readonly BlockScheduleEntry[];
  exits: readonly PlannedExit[];
}>;

export function collectValueUses(input: ValueUseInput): readonly ValueUse[] {
  const roots = [
    ...rootsForSchedule(input.schedule),
    ...rootsForExitStores(input.schedule, input.exits)
  ];

  return expandRootsWithLiveMemoryLoadValues(roots, input.schedule);
}

export function rootsForSchedule(
  schedule: readonly BlockScheduleEntry[]
): readonly ValueRoot[] {
  return schedule.flatMap(rootsForScheduleEntry);
}

export function rootsForExitStores(
  schedule: readonly BlockScheduleEntry[],
  exits: readonly PlannedExit[]
): readonly ValueRoot[] {
  const plannedExits = new Map(exits.map((exit) => [exit.id, exit]));

  return schedule.flatMap((entry) =>
    exitsForScheduleEntry(entry).flatMap((exit) =>
      rootsForExitStore(requiredPlannedExit(plannedExits, exit), entry.at)
    )
  );
}

export function expandRootUse(root: ValueRoot): readonly ValueUse[] {
  const value = simplifyValue(root.value);

  return usesForValue(root, value, value, []);
}

function expandRootsWithLiveMemoryLoadValues(
  initialRoots: readonly ValueRoot[],
  schedule: readonly BlockScheduleEntry[]
): readonly ValueUse[] {
  const roots = [...initialRoots];
  const uses: ValueUse[] = [];
  const rootedMemoryLoadValues: JitLoadResultValue[] = [];

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];

    if (root === undefined) {
      throw new Error(`missing JIT value-use root: ${index}`);
    }

    const rootUses = expandRootUse(root);

    uses.push(...rootUses);

    for (const use of rootUses) {
      const value = simplifyValue(use.value);

      if (value.kind !== "loadResult") {
        continue;
      }

      if (memoryLoadValueWasRooted(rootedMemoryLoadValues, value)) {
        continue;
      }

      rootedMemoryLoadValues.push(value);

      const entry = memoryLoadValueEntryForResult(schedule, value);

      if (entry === undefined) {
        continue;
      }

      roots.push(valueRoot(entry.address, entry.at, rootPath(), "memoryAddress"));
    }
  }

  return uses;
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

function rootsForScheduleEntry(entry: BlockScheduleEntry): readonly ValueRoot[] {
  switch (entry.kind) {
    case "memoryGuard":
      return [
        valueRoot(entry.address, entry.at, rootPath(), "memoryAddress")
      ];
    case "memoryStore":
      return [
        valueRoot(entry.address, entry.at, entryPath(entry), "memoryAddress"),
        valueRoot(entry.value, entry.at, entryPath(entry), "memoryValue")
      ];
    case "jump":
      return [
        valueRoot(entry.target, entry.at, entry.exit.path, "controlTarget")
      ];
    case "branch":
      return [
        valueRoot(entry.condition, entry.at, entryPath(entry), "branchCondition"),
        valueRoot(entry.takenTarget, entry.at, entry.taken.path, "branchTarget"),
        valueRoot(entry.notTakenTarget, entry.at, entry.notTaken.path, "branchTarget")
      ];
    case "hostTrap":
      return [
        valueRoot(entry.vector, entry.at, rootPath(), "trapVector")
      ];
    case "defineLoadResult":
    case "fallthrough":
      return [];
  }
}

function memoryLoadValueEntryForResult(
  schedule: readonly BlockScheduleEntry[],
  value: JitLoadResultValue
): MemoryLoadValueEntry | undefined {
  return schedule.find((entry): entry is MemoryLoadValueEntry =>
    entry.kind === "defineLoadResult" &&
      valuesEqual(entry.result, value)
  );
}

function memoryLoadValueWasRooted(
  rooted: readonly JitLoadResultValue[],
  value: JitLoadResultValue
): boolean {
  return rooted.some((entry) => valuesEqual(entry, value));
}

function entryPath(entry: RuntimeEntry): Path {
  switch (entry.kind) {
    case "memoryGuard":
      return rootPath();
    case "jump":
      return entry.exit.path;
    case "branch":
    case "memoryStore":
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

function exitsForScheduleEntry(entry: BlockScheduleEntry): readonly Exit[] {
  switch (entry.kind) {
    case "memoryGuard":
      return [entry.exit];
    case "jump":
    case "hostTrap":
    case "fallthrough":
      return [entry.exit];
    case "branch":
      return [entry.taken, entry.notTaken];
    case "memoryStore":
    case "defineLoadResult":
      return [];
  }
}

function requiredPlannedExit(
  plannedExits: ReadonlyMap<string, PlannedExit>,
  exit: Exit
): PlannedExit {
  const planned = plannedExits.get(exit.id);

  if (planned === undefined) {
    throw new Error(`missing planned JIT exit for value uses: ${exit.id}`);
  }

  return planned;
}
