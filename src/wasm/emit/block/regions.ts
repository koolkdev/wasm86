import { assert } from "#common/assert.js";
import type { BlockExit, BlockExitId } from "#ir/block/exits.js";
import type { BlockActionSite } from "#ir/block/timeline.js";
import type { BlockEdgeId } from "#ir/block/planning/geometry/index.js";
import type {
  BlockLayout,
  LayoutRegion,
  LayoutStep,
  LayoutTimelineInput
} from "#ir/block/planning/layout/index.js";
import type {
  PlannedStateWrite,
  StateWriteId,
  StateWritePlan
} from "#ir/block/planning/state-writes.js";
import type {
  WasmLayoutActionEdge,
  WasmLayoutExitPayload
} from "./types.js";

export type LayoutRegionIndex = Readonly<{
  main: LayoutRegion;
  edgeById: ReadonlyMap<BlockEdgeId, LayoutEdgeRegion>;
  edgeByExit: ReadonlyMap<BlockExitId, LayoutEdgeRegion>;
}>;

export type LayoutEdgeRegion = Readonly<{
  edge: BlockEdgeId;
  exit: BlockExit;
  region: LayoutRegion;
}>;

export function indexLayoutRegions(layout: BlockLayout): LayoutRegionIndex {
  let main: LayoutRegion | undefined;
  const edgeById = new Map<BlockEdgeId, LayoutEdgeRegion>();
  const edgeByExit = new Map<BlockExitId, LayoutEdgeRegion>();

  for (const region of layout.regions) {
    switch (region.path.kind) {
      case "main":
        assert(main === undefined, "block layout contains multiple main regions");

        main = region;
        break;
      case "edge": {
        assert(!edgeById.has(region.path.edge), `block layout contains duplicate edge region ${region.path.edge}`);

        const exit = regionExit(region);
        const edgeRegion = Object.freeze({
          edge: region.path.edge,
          exit,
          region
        } satisfies LayoutEdgeRegion);

        assert(!edgeByExit.has(exit.id), `block layout contains duplicate exit region ${exit.id}`);

        edgeById.set(region.path.edge, edgeRegion);
        edgeByExit.set(exit.id, edgeRegion);
        break;
      }
    }
  }

  assert(main !== undefined, "block layout is missing its main region");

  return Object.freeze({
    main,
    edgeById: Object.freeze(new Map(edgeById)),
    edgeByExit: Object.freeze(new Map(edgeByExit))
  } satisfies LayoutRegionIndex);
}

export function indexStateWrites(stateWrites: StateWritePlan): ReadonlyMap<StateWriteId, PlannedStateWrite> {
  const byId = new Map<StateWriteId, PlannedStateWrite>();

  for (const write of stateWrites.writes) {
    assert(!byId.has(write.id), `state write plan contains duplicate write ${write.id}`);

    byId.set(write.id, write);
  }

  return Object.freeze(new Map(byId));
}

export function actionEdgesForSite(
  site: BlockActionSite,
  regions: LayoutRegionIndex,
  inputs: readonly LayoutTimelineInput[]
): readonly WasmLayoutActionEdge[] {
  return Object.freeze(actionExits(site).map((exit) => {
    const region = regions.edgeByExit.get(exit.id);

    assert(region !== undefined, `layout has no region for block exit ${exit.id}`);

    return Object.freeze({
      edge: region.edge,
      exit,
      exitPayload: exitPayloadForEdge(region.edge, inputs)
    } satisfies WasmLayoutActionEdge);
  }));
}

function exitPayloadForEdge(
  edge: BlockEdgeId,
  inputs: readonly LayoutTimelineInput[]
): WasmLayoutExitPayload {
  let payloadInput: LayoutTimelineInput | undefined;

  for (const input of inputs) {
    if (input.use.kind !== "exit-payload" || input.use.edge !== edge) {
      continue;
    }

    assert(payloadInput === undefined, `layout edge ${edge} has multiple exit payload inputs`);
    payloadInput = input;
  }

  return payloadInput === undefined
    ? Object.freeze({ kind: "none" } satisfies WasmLayoutExitPayload)
    : Object.freeze({ kind: "input", input: payloadInput } satisfies WasmLayoutExitPayload);
}

function regionExit(region: LayoutRegion): BlockExit {
  const exitSteps = region.steps.filter((step): step is Extract<LayoutStep, { kind: "exit" }> =>
    step.kind === "exit"
  );
  const exitStep = exitSteps[0];

  assert(
    exitStep !== undefined && exitSteps.length === 1 && region.steps.at(-1) === exitStep,
    `edge layout region ${region.id} must end with exactly one exit step`
  );

  return exitStep.exit;
}

function actionExits(site: BlockActionSite): readonly BlockExit[] {
  switch (site.action.kind) {
    case "memoryGuard":
      return [site.action.faultExit];
    case "memoryStore":
    case "dynamicRegisterStore":
      return [];
    case "jump":
    case "hostTrap":
    case "fallthrough":
      return [site.action.exit];
    case "branch":
      return [site.action.taken, site.action.notTaken];
  }
}
