import type { AnalyzedRuntimeAction } from "#backends/wasm/jit/analysis/runtime.js";
import type { BlockAnalysis } from "#backends/wasm/jit/analysis/block.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";
import type {
  MemoryLoadValue,
  Timeline
} from "#backends/wasm/jit/analysis/timeline-types.js";
import type { JitBoundExprOp } from "#backends/wasm/jit/ir/bound-expressions.js";
import {
  jitExpressionOpEpochs
} from "./epochs.js";
import type {
  PlannedExit
} from "./types.js";
import type {
  BlockSchedule,
  BlockScheduleEntry,
  DefinitionEntry,
  MemoryLoadValueEntry,
  Placement,
  RuntimeEntry
} from "./schedule-types.js";

export type ScheduleInput = Readonly<{
  ops: readonly ScheduleOp[];
  timeline: Timeline;
  opEpochs: readonly number[];
  plannedExits: ReadonlyMap<string, PlannedExit>;
}>;

export type ScheduleAnalysisInput = Readonly<{
  analysis: BlockAnalysis;
  plannedExits: ReadonlyMap<string, PlannedExit>;
}>;

export type ScheduleOp = Readonly<{
  expression: JitBoundExprOp;
  runtimeActions: readonly AnalyzedRuntimeAction[];
  memoryLoadValues: readonly MemoryLoadValue[];
}>;

export function planSchedule(input: ScheduleInput): BlockSchedule {
  return input.ops.flatMap((op) =>
    scheduleEntriesForOp(input, op)
  );
}

export function scheduleInputForAnalysis(input: ScheduleAnalysisInput): ScheduleInput {
  const { analysis, plannedExits } = input;
  const runtimeActionsByOp = entriesByOp(analysis.runtime.actions, (entry) => entry.at.opIndex);
  const memoryLoadValuesByOp = entriesByOp(analysis.timeline.memoryLoadValues, (entry) => entry.opIndex);

  return {
    ops: analysis.expressions.map((expression, opIndex) => ({
      expression,
      runtimeActions: runtimeActionsByOp.get(opIndex) ?? [],
      memoryLoadValues: memoryLoadValuesByOp.get(opIndex) ?? []
    })),
    timeline: analysis.timeline,
    opEpochs: jitExpressionOpEpochs({
      expressions: analysis.expressions,
      valueTimeline: analysis.timeline
    }),
    plannedExits
  };
}

function scheduleEntriesForOp(
  input: ScheduleInput,
  op: ScheduleOp
): readonly BlockScheduleEntry[] {
  return [
    ...runtimeEntriesForOp(input, op),
    ...definitionEntriesForOp(input, op)
  ];
}

function runtimeEntriesForOp(
  input: ScheduleInput,
  op: ScheduleOp
): readonly RuntimeEntry[] {
  return op.runtimeActions.map((runtimeAction) =>
    planRuntimeEntry(runtimeAction, op, input)
  );
}

function definitionEntriesForOp(
  input: ScheduleInput,
  op: ScheduleOp
): readonly DefinitionEntry[] {
  return op.memoryLoadValues.map((memoryLoadValue) =>
    planMemoryLoadValue(memoryLoadValue, op, input)
  );
}

function planRuntimeEntry(
  runtimeAction: AnalyzedRuntimeAction,
  op: ScheduleOp,
  input: ScheduleInput
): RuntimeEntry {
  const { opEpochs, plannedExits, timeline } = input;
  const at = placementForOp(runtimeAction.at.opIndex, opEpochs, "runtime entry");
  const expressionOp = op.expression;
  const view = timeline.viewAt(at.opIndex);

  switch (runtimeAction.kind) {
    case "memoryGuard": {
      if (expressionOp.op !== "memory.guard") {
        return unexpectedRuntimeOp(runtimeAction, expressionOp.op);
      }

      return {
        kind: runtimeAction.kind,
        at,
        address: view.value(expressionOp.address),
        byteLength: expressionOp.byteLength,
        access: expressionOp.access,
        exit: plannedExitFor(plannedExits, runtimeAction.faultExit)
      };
    }
    case "memoryStore": {
      if (expressionOp.op !== "set") {
        return unexpectedRuntimeOp(runtimeAction, expressionOp.op);
      }

      return {
        kind: runtimeAction.kind,
        at,
        address: view.storageAddress(expressionOp.target),
        value: view.value(expressionOp.value),
        width: expressionOp.accessWidth
      };
    }
    case "jump": {
      if (expressionOp.op !== "jump") {
        return unexpectedRuntimeOp(runtimeAction, expressionOp.op);
      }

      return {
        kind: runtimeAction.kind,
        at,
        target: view.value(expressionOp.target),
        exit: plannedExitFor(plannedExits, runtimeAction.exit)
      };
    }
    case "branch": {
      if (expressionOp.op !== "conditionalJump") {
        return unexpectedRuntimeOp(runtimeAction, expressionOp.op);
      }

      assertDistinctBranchExits(runtimeAction);

      return {
        kind: runtimeAction.kind,
        at,
        condition: view.value(expressionOp.condition),
        takenTarget: view.value(expressionOp.taken),
        notTakenTarget: view.value(expressionOp.notTaken),
        taken: plannedExitFor(plannedExits, runtimeAction.taken),
        notTaken: plannedExitFor(plannedExits, runtimeAction.notTaken)
      };
    }
    case "hostTrap": {
      if (expressionOp.op !== "hostTrap") {
        return unexpectedRuntimeOp(runtimeAction, expressionOp.op);
      }

      return {
        kind: runtimeAction.kind,
        at,
        vector: view.value(expressionOp.vector),
        exit: plannedExitFor(plannedExits, runtimeAction.exit)
      };
    }
    case "fallthrough": {
      if (expressionOp.op !== "next") {
        return unexpectedRuntimeOp(runtimeAction, expressionOp.op);
      }

      return {
        kind: runtimeAction.kind,
        at,
        exit: plannedExitFor(plannedExits, runtimeAction.exit)
      };
    }
  }
}

function planMemoryLoadValue(
  memoryLoadValue: MemoryLoadValue,
  op: ScheduleOp,
  input: ScheduleInput
): MemoryLoadValueEntry {
  const { opEpochs, timeline } = input;
  const at = placementForOp(memoryLoadValue.opIndex, opEpochs, "memory-load value");
  const expressionOp = op.expression;
  const view = timeline.viewAt(at.opIndex);

  if (expressionOp.op !== "let32") {
    throw new Error(`JIT memory-load value mapped to expression op ${expressionOp.op}`);
  }

  if (
    expressionOp.dst.kind !== memoryLoadValue.ref.kind ||
    expressionOp.dst.id !== memoryLoadValue.ref.id
  ) {
    throw new Error(`JIT memory-load value ref mismatch at expression op ${at.opIndex}`);
  }

  if (expressionOp.value.kind !== "source" || expressionOp.value.source.kind !== "mem") {
    throw new Error(`JIT memory-load value mapped to ${expressionOp.value.kind}`);
  }

  return {
    kind: "defineLoadResult",
    at,
    result: memoryLoadValue.value,
    address: view.storageAddress(expressionOp.value.source),
    width: expressionOp.value.accessWidth,
    signed: expressionOp.value.signed === true
  };
}

function placementForOp(
  opIndex: number,
  opEpochs: readonly number[],
  label: string
): Placement {
  const epoch = opEpochs[opIndex];

  if (epoch === undefined) {
    throw new Error(`missing JIT ${label} epoch for expression op ${opIndex}`);
  }

  return {
    opIndex,
    epoch
  };
}

function assertDistinctBranchExits(
  runtimeAction: Extract<AnalyzedRuntimeAction, { kind: "branch" }>
): void {
  if (runtimeAction.taken.id === runtimeAction.notTaken.id) {
    throw new Error(`JIT branch runtime entry has duplicate exits: ${runtimeAction.taken.id}`);
  }
}

function unexpectedRuntimeOp(
  runtimeAction: AnalyzedRuntimeAction,
  op: string
): never {
  throw new Error(`JIT runtime schedule entry ${runtimeAction.kind} mapped to expression op ${op}`);
}

function plannedExitFor(
  plannedExits: ReadonlyMap<string, PlannedExit>,
  analyzedExit: Exit
): PlannedExit {
  const exit = plannedExits.get(analyzedExit.id);

  if (exit === undefined) {
    throw new Error(`missing planned JIT schedule exit: ${analyzedExit.id}`);
  }

  return exit;
}

function entriesByOp<TEntry>(
  entries: readonly TEntry[],
  opIndex: (entry: TEntry) => number
): ReadonlyMap<number, readonly TEntry[]> {
  const byOp = new Map<number, TEntry[]>();

  for (const entry of entries) {
    const index = opIndex(entry);
    const existing = byOp.get(index) ?? [];

    byOp.set(index, [...existing, entry]);
  }

  return byOp;
}
