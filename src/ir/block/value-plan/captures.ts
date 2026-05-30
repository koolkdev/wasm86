import type { SourceCell } from "#ir/block/source-cells.js";
import type { FlagName } from "#ir/model/flags.js";
import {
  addRegisterWait,
  createRegisterWaits,
  registerWaitsForBarrier,
  registerWaitsOverlappingWrite,
  removeRegisterWait,
  type RegisterWaits
} from "./register-waits.js";
import type { SourceEffect } from "./source-effects.js";
import type {
  PlannedCapture,
  PlannedValue,
  PlannedValueId
} from "./types.js";

type WaitingSourceEdge = Readonly<{
  value: PlannedValue;
  source: SourceCell;
}>;

type WaitingSourceIndexes = Readonly<{
  registers: RegisterWaits<RegisterWaitingSourceEdge>;
  flags: Map<FlagName, Set<WaitingSourceEdge>>;
  byValue: Map<PlannedValueId, Set<WaitingSourceEdge>>;
}>;

type RegisterWaitingSourceEdge = WaitingSourceEdge & Readonly<{
  source: Extract<SourceCell, { kind: "reg" }>;
}>;

export function planSourceCaptures(
  values: readonly PlannedValue[],
  sourceEffects: readonly SourceEffect[]
): readonly PlannedCapture[] {
  const captures: PlannedCapture[] = [];
  const indexes = waitingSourceIndexes(values);
  const valuesByFirstEntry = [...values].sort((left, right) =>
    left.lifetime.firstEntry - right.lifetime.firstEntry || left.id - right.id
  );
  const effects = [...sourceEffects].sort((left, right) => left.entryIndex - right.entryIndex);
  let nextMaterializedValue = 0;

  for (const effect of effects) {
    while (
      nextMaterializedValue < valuesByFirstEntry.length &&
      valuesByFirstEntry[nextMaterializedValue]!.lifetime.firstEntry <= effect.entryIndex
    ) {
      removeWaitingValue(indexes, valuesByFirstEntry[nextMaterializedValue]!);
      nextMaterializedValue += 1;
    }

    switch (effect.kind) {
      case "write":
        captureWaitingSourceWrites(indexes, captures, effect);
        break;
      case "barrier":
        captureWaitingBarriers(indexes, captures, effect);
        break;
    }
  }

  return Object.freeze(captures);
}

function waitingSourceIndexes(values: readonly PlannedValue[]): WaitingSourceIndexes {
  const indexes: WaitingSourceIndexes = {
    registers: createRegisterWaits(),
    flags: new Map(),
    byValue: new Map()
  };

  for (const value of values) {
    const edges = new Set<WaitingSourceEdge>();

    for (const source of value.deps.sourceCells) {
      const edge = Object.freeze({ value, source });

      edges.add(edge);
      addWaitingSourceEdge(indexes, edge);
    }

    indexes.byValue.set(value.id, edges);
  }

  return indexes;
}

function addWaitingSourceEdge(
  indexes: WaitingSourceIndexes,
  edge: WaitingSourceEdge
): void {
  switch (edge.source.kind) {
    case "reg":
      addRegisterWait(indexes.registers, edge as RegisterWaitingSourceEdge);
      break;
    case "flag":
      addWaitingEdgeToMap(indexes.flags, edge.source.flag, edge);
      break;
  }
}

function addWaitingEdgeToMap<Key>(
  map: Map<Key, Set<WaitingSourceEdge>>,
  key: Key,
  edge: WaitingSourceEdge
): void {
  const edges = map.get(key);

  if (edges === undefined) {
    map.set(key, new Set([edge]));
  } else {
    edges.add(edge);
  }
}

function removeWaitingValue(
  indexes: WaitingSourceIndexes,
  value: PlannedValue
): void {
  const edges = indexes.byValue.get(value.id);

  if (edges === undefined) {
    return;
  }

  for (const edge of [...edges]) {
    removeWaitingSourceEdge(indexes, edge);
  }

  indexes.byValue.delete(value.id);
}

function removeWaitingSourceEdge(
  indexes: WaitingSourceIndexes,
  edge: WaitingSourceEdge
): void {
  switch (edge.source.kind) {
    case "reg":
      removeRegisterWait(indexes.registers, edge as RegisterWaitingSourceEdge);
      break;
    case "flag":
      indexes.flags.get(edge.source.flag)?.delete(edge);
      break;
  }

  indexes.byValue.get(edge.value.id)?.delete(edge);
}

function captureWaitingSourceWrites(
  indexes: WaitingSourceIndexes,
  captures: PlannedCapture[],
  effect: Extract<SourceEffect, { kind: "write" }>
): void {
  switch (effect.source.kind) {
    case "reg":
      captureRegisterEdges(
        indexes,
        captures,
        effect,
        registerWaitsOverlappingWrite(indexes.registers, effect.source)
      );
      break;
    case "flag":
      captureFlagEdges(indexes, captures, effect, effect.source.flag);
      break;
  }
}

function captureWaitingBarriers(
  indexes: WaitingSourceIndexes,
  captures: PlannedCapture[],
  effect: Extract<SourceEffect, { kind: "barrier" }>
): void {
  switch (effect.scope) {
    case "registers":
      captureRegisterEdges(indexes, captures, effect, registerWaitsForBarrier(indexes.registers));
      break;
  }
}

function captureRegisterEdges(
  indexes: WaitingSourceIndexes,
  captures: PlannedCapture[],
  effect: SourceEffect,
  edges: readonly RegisterWaitingSourceEdge[]
): void {
  for (const edge of [...edges]) {
    captureWaitingSourceEdge(indexes, captures, effect, edge);
  }
}

function captureFlagEdges(
  indexes: WaitingSourceIndexes,
  captures: PlannedCapture[],
  effect: SourceEffect,
  flag: FlagName
): void {
  const edges = indexes.flags.get(flag);

  if (edges === undefined) {
    return;
  }

  for (const edge of [...edges]) {
    captureWaitingSourceEdge(indexes, captures, effect, edge);
  }
}

function captureWaitingSourceEdge(
  indexes: WaitingSourceIndexes,
  captures: PlannedCapture[],
  effect: SourceEffect,
  edge: WaitingSourceEdge
): void {
  captures.push(Object.freeze({
    value: edge.value.id,
    source: edge.source,
    before: effect,
    entryIndex: effect.entryIndex,
    at: effect.at
  }));
  removeWaitingValue(indexes, edge.value);
}
