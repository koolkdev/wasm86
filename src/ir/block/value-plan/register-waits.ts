import type { SourceCell } from "#ir/block/source-cells.js";
import {
  widthMask,
  type Reg32
} from "#x86/types.js";

type RegisterSourceCell = Extract<SourceCell, { kind: "reg" }>;

export type RegisterWaitEdge = Readonly<{
  source: RegisterSourceCell;
}>;

export type RegisterWaits<Edge extends RegisterWaitEdge> = Readonly<{
  all: Set<Edge>;
  lanes: Map<Reg32, Map<number, Set<Edge>>>;
}>;

export function createRegisterWaits<Edge extends RegisterWaitEdge>(): RegisterWaits<Edge> {
  return {
    all: new Set(),
    lanes: new Map()
  };
}

export function addRegisterWait<Edge extends RegisterWaitEdge>(
  waits: RegisterWaits<Edge>,
  edge: Edge
): void {
  waits.all.add(edge);

  for (const lane of registerAliasByteLanes(edge.source)) {
    const laneEdges = laneWaits(waits, edge.source.reg.base, lane);

    laneEdges.add(edge);
  }
}

export function removeRegisterWait<Edge extends RegisterWaitEdge>(
  waits: RegisterWaits<Edge>,
  edge: Edge
): void {
  waits.all.delete(edge);

  for (const lane of registerAliasByteLanes(edge.source)) {
    const laneEdges = waits.lanes.get(edge.source.reg.base)?.get(lane);

    laneEdges?.delete(edge);
  }
}

export function registerWaitsOverlappingWrite<Edge extends RegisterWaitEdge>(
  waits: RegisterWaits<Edge>,
  source: RegisterSourceCell
): readonly Edge[] {
  const edges = new Set<Edge>();

  for (const lane of registerAliasByteLanes(source)) {
    const laneEdges = waits.lanes.get(source.reg.base)?.get(lane);

    if (laneEdges === undefined) {
      continue;
    }

    for (const edge of laneEdges) {
      edges.add(edge);
    }
  }

  return Object.freeze([...edges]);
}

export function registerWaitsForBarrier<Edge extends RegisterWaitEdge>(
  waits: RegisterWaits<Edge>
): readonly Edge[] {
  return Object.freeze([...waits.all]);
}

function laneWaits<Edge extends RegisterWaitEdge>(
  waits: RegisterWaits<Edge>,
  base: Reg32,
  lane: number
): Set<Edge> {
  let baseLanes = waits.lanes.get(base);

  if (baseLanes === undefined) {
    baseLanes = new Map();
    waits.lanes.set(base, baseLanes);
  }

  let edges = baseLanes.get(lane);

  if (edges === undefined) {
    edges = new Set();
    baseLanes.set(lane, edges);
  }

  return edges;
}

function registerAliasByteLanes(source: RegisterSourceCell): readonly number[] {
  const lanes: number[] = [];
  const mask = registerAliasMask(source);

  for (let lane = 0; lane < 4; lane += 1) {
    const laneMask = 0xff << (lane * 8);

    if ((mask & laneMask) !== 0) {
      lanes.push(lane);
    }
  }

  return Object.freeze(lanes);
}

function registerAliasMask(source: RegisterSourceCell): number {
  return (widthMask(source.reg.width) << source.reg.bitOffset) >>> 0;
}
