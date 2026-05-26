import type {
  BoundaryScheduleEntry,
  BlockSchedule,
  BlockScheduleEntry,
  DefinitionScheduleEntry,
  Placement
} from "#x86/block/schedule.js";
import { exprInput } from "#x86/expr/builders.js";
import {
  exprDependencies
} from "#x86/expr/dependencies.js";
import type {
  ExprInputSource,
  ExprRef,
  ExprUse
} from "#x86/expr/types.js";
import {
  bitsUse,
  full32Use
} from "#x86/expr/uses.js";
import {
  widthMask,
} from "#x86/isa/types.js";

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
      source: "schedule" | "closure";
    }>
  | Readonly<{ kind: "boundaryCell"; cell: BoundaryRootCellSource }>;

export type BlockRoot = Readonly<{
  expr: ExprRef;
  use: ExprUse;
  at: Placement;
  purpose: BlockRootPurpose;
  entry: BlockScheduleEntry;
}>;

export type BlockRoots = readonly BlockRoot[];

type DefinitionScheduleRecord = Readonly<{
  entry: DefinitionScheduleEntry;
  index: number;
}>;

export function rootsForSchedule(schedule: BlockSchedule): BlockRoots {
  return new BlockRootDiscovery(schedule).roots();
}

class BlockRootDiscovery {
  readonly #schedule: BlockSchedule;
  readonly #definitions = new Map<number, DefinitionScheduleRecord>();
  readonly #entryIndexes = new Map<BlockScheduleEntry, number>();
  readonly #closedProducerInputs = new Set<number>();
  readonly #roots: BlockRoot[] = [];

  constructor(schedule: BlockSchedule) {
    this.#schedule = schedule;
    this.#indexSchedule();
  }

  roots(): BlockRoots {
    this.#roots.push(...this.#schedule.flatMap(rootsForScheduleEntry));
    this.#closeDefinitionInputs();

    return Object.freeze(this.#roots);
  }

  #indexSchedule(): void {
    for (const [index, entry] of this.#schedule.entries()) {
      this.#entryIndexes.set(entry, index);

      if (entry.role !== "definition") {
        continue;
      }

      if (this.#definitions.has(entry.definition.id)) {
        throw new Error(`duplicate block definition id ${entry.definition.id} in schedule`);
      }

      this.#definitions.set(entry.definition.id, Object.freeze({ entry, index }));
    }
  }

  #closeDefinitionInputs(): void {
    for (let index = 0; index < this.#roots.length; index += 1) {
      const current = this.#roots[index];

      if (current === undefined) {
        throw new Error(`missing block root at index ${index}`);
      }

      this.#closeRootDefinitionInputs(current);
    }
  }

  #closeRootDefinitionInputs(rootEntry: BlockRoot): void {
    const rootEntryIndex = this.#requiredEntryIndex(rootEntry.entry);

    for (const dep of exprDependencies(rootEntry.expr, rootEntry.use)) {
      if (dep.kind !== "def") {
        continue;
      }

      const definition = this.#definitions.get(dep.id);

      if (definition === undefined) {
        throw new Error(`block-defined value ${dep.id} is not present in the schedule`);
      }

      if (definition.index >= rootEntryIndex) {
        throw new Error(
          `block-defined value ${dep.id} is observed before its definition placement`
        );
      }

      if (this.#closedProducerInputs.has(dep.id)) {
        continue;
      }

      this.#closedProducerInputs.add(dep.id);
      this.#roots.push(...producerInputRoots(definition.entry));
    }
  }

  #requiredEntryIndex(entry: BlockScheduleEntry): number {
    const index = this.#entryIndexes.get(entry);

    if (index === undefined) {
      throw new Error("block root references an entry outside the schedule");
    }

    return index;
  }
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
        root(entry.action.address, full32Use(), entry, { kind: "actionInput", input: "address" })
      ];
    case "memoryStore":
      return [
        root(entry.action.address, full32Use(), entry, { kind: "actionInput", input: "address" }),
        root(entry.action.value, lowBitsUse(entry.action.width), entry, { kind: "actionInput", input: "value" })
      ];
    case "dynamicRegisterStore":
      return [
        root(entry.action.index, full32Use(), entry, { kind: "actionInput", input: "index" }),
        root(entry.action.value, lowBitsUse(entry.action.width), entry, { kind: "actionInput", input: "value" })
      ];
    case "jump":
      return [
        root(entry.action.target, full32Use(), entry, { kind: "actionInput", input: "target" })
      ];
    case "branch": {
      const roots = [
        root(entry.action.condition, full32Use(), entry, { kind: "actionInput", input: "condition" }),
        root(entry.action.takenTarget, full32Use(), entry, {
          kind: "actionInput",
          input: "target",
          direction: "taken"
        })
      ];

      if (entry.action.continuation.value !== undefined) {
        roots.push(root(entry.action.continuation.value, full32Use(), entry, {
          kind: "actionInput",
          input: "target",
          direction: "notTaken"
        }));
      }

      return roots;
    }
    case "hostTrap":
      return [
        root(entry.action.vector, full32Use(), entry, { kind: "actionInput", input: "vector" })
      ];
    case "fallthrough":
      return entry.action.continuation.value === undefined
        ? []
        : [
            root(entry.action.continuation.value, full32Use(), entry, {
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
        root(entry.definition.address, full32Use(), entry, {
          kind: "definitionInput",
          input: "address",
          source: "schedule"
        })
      ];
    case "dynamicRegisterLoad":
      return [
        root(entry.definition.index, full32Use(), entry, {
          kind: "definitionInput",
          input: "index",
          source: "schedule"
        })
      ];
  }
}

function rootsForBoundaryEntry(entry: BoundaryScheduleEntry): readonly BlockRoot[] {
  const roots: BlockRoot[] = [];

  for (const cell of entry.state.registers.cells()) {
    roots.push(root(cell.value, full32Use(), entry, {
      kind: "boundaryCell",
      cell: { kind: "reg", reg: cell.reg }
    }));
  }

  for (const { flag, cell } of entry.state.flags.cells()) {
    switch (cell.kind) {
      case "expr":
        roots.push(root(cell.value, bitsUse(1), entry, {
          kind: "boundaryCell",
          cell: { kind: "flag", flag }
        }));
        break;
      case "input":
        roots.push(root(exprInput({ kind: "flag", flag: cell.flag }), bitsUse(1), entry, {
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

function producerInputRoots(entry: DefinitionScheduleEntry): readonly BlockRoot[] {
  const definition = entry.definition;

  switch (definition.kind) {
    case "memoryLoad":
      return [
        root(definition.address, full32Use(), entry, producerPurpose("address"))
      ];
    case "dynamicRegisterLoad":
      return [
        root(definition.index, full32Use(), entry, producerPurpose("index"))
      ];
  }
}

function producerPurpose(
  input: "address" | "index"
): BlockRootPurpose {
  return {
    kind: "definitionInput",
    input,
    source: "closure"
  };
}

function root(
  expr: ExprRef,
  use: ExprUse,
  entry: BlockScheduleEntry,
  purpose: BlockRootPurpose
): BlockRoot {
  return Object.freeze({
    expr,
    use,
    at: entry.at,
    purpose: Object.freeze(purpose),
    entry
  });
}

function lowBitsUse(width: 8 | 16 | 32): ExprUse {
  return bitsUse(widthMask(width));
}
