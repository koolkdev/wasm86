import type {
  BoundaryScheduleEntry,
  BlockSchedule,
  BlockScheduleEntry,
  DefinitionScheduleEntry,
  Placement
} from "#ir/block/schedule.js";
import { exprInput } from "#ir/expr/builders.js";
import type {
  ExprInputSource,
  ExprRef
} from "#ir/expr/types.js";

export type BoundaryRootCellSource = Extract<
  ExprInputSource,
  Readonly<{ kind: "reg" | "flag" }>
>;

export type BlockRootPurpose =
  | Readonly<{
      kind: "actionInput";
      input: "address" | "value" | "index" | "condition" | "target" | "vector";
      direction?: "taken" | "notTaken";
    }>
  | Readonly<{
      kind: "definitionInput";
      input: "address" | "index";
    }>
  | Readonly<{ kind: "boundaryCell"; cell: BoundaryRootCellSource }>;

export type BlockRoot = Readonly<{
  expr: ExprRef;
  at: Placement;
  purpose: BlockRootPurpose;
  entry: BlockScheduleEntry;
}>;

export type BlockRoots = readonly BlockRoot[];

export function rootsForSchedule(schedule: BlockSchedule): BlockRoots {
  return Object.freeze(schedule.flatMap(rootsForScheduleEntry));
}

function rootsForScheduleEntry(entry: BlockScheduleEntry): readonly BlockRoot[] {
  switch (entry.role) {
    case "action":
      return rootsForActionEntry(entry);
    case "definition":
      return rootsForDefinitionEntry(entry);
    case "boundary":
      return rootsForBoundaryEntry(entry);
  }
}

function rootsForActionEntry(
  entry: Extract<BlockScheduleEntry, { role: "action" }>
): readonly BlockRoot[] {
  switch (entry.action.kind) {
    case "memoryGuard":
      return [
        root(entry.action.address, entry, { kind: "actionInput", input: "address" })
      ];
    case "memoryStore":
      return [
        root(entry.action.address, entry, { kind: "actionInput", input: "address" }),
        root(entry.action.value, entry, { kind: "actionInput", input: "value" })
      ];
    case "dynamicRegisterStore":
      return [
        root(entry.action.index, entry, { kind: "actionInput", input: "index" }),
        root(entry.action.value, entry, { kind: "actionInput", input: "value" })
      ];
    case "jump":
      return [
        root(entry.action.target, entry, { kind: "actionInput", input: "target" })
      ];
    case "branch": {
      const roots = [
        root(entry.action.condition, entry, { kind: "actionInput", input: "condition" }),
        root(entry.action.takenTarget, entry, {
          kind: "actionInput",
          input: "target",
          direction: "taken"
        })
      ];

      if (entry.action.continuation.value !== undefined) {
        roots.push(root(entry.action.continuation.value, entry, {
          kind: "actionInput",
          input: "target",
          direction: "notTaken"
        }));
      }

      return roots;
    }
    case "hostTrap":
      return [
        root(entry.action.vector, entry, { kind: "actionInput", input: "vector" })
      ];
    case "fallthrough":
      return entry.action.continuation.value === undefined
        ? []
        : [
            root(entry.action.continuation.value, entry, {
              kind: "actionInput",
              input: "target"
            })
          ];
  }
}

function rootsForDefinitionEntry(entry: DefinitionScheduleEntry): readonly BlockRoot[] {
  switch (entry.definition.kind) {
    case "memoryLoad":
      return [
        root(entry.definition.address, entry, {
          kind: "definitionInput",
          input: "address"
        })
      ];
    case "dynamicRegisterLoad":
      return [
        root(entry.definition.index, entry, {
          kind: "definitionInput",
          input: "index"
        })
      ];
  }
}

function rootsForBoundaryEntry(entry: BoundaryScheduleEntry): readonly BlockRoot[] {
  const roots: BlockRoot[] = [];

  for (const cell of entry.state.registers.cells()) {
    roots.push(root(cell.value, entry, {
      kind: "boundaryCell",
      cell: { kind: "reg", reg: cell.reg }
    }));
  }

  for (const { flag, cell } of entry.state.flags.cells()) {
    switch (cell.kind) {
      case "expr":
        roots.push(root(cell.value, entry, {
          kind: "boundaryCell",
          cell: { kind: "flag", flag }
        }));
        break;
      case "input":
        roots.push(root(exprInput({ kind: "flag", flag: cell.flag }), entry, {
          kind: "boundaryCell",
          cell: { kind: "flag", flag }
        }));
        break;
      case "undef":
        break;
    }
  }

  return roots;
}

function root(
  expr: ExprRef,
  entry: BlockScheduleEntry,
  purpose: BlockRootPurpose
): BlockRoot {
  return Object.freeze({
    expr,
    at: entry.at,
    purpose: Object.freeze(purpose),
    entry
  });
}
