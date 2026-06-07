import { assert } from "#common/assert.js";
import type { BlockActionSite } from "#ir/block/timeline.js";
import type {
  LayoutExprUse,
  LayoutRegion,
  LayoutRegionId,
  LayoutStep,
  LayoutTimelineInput
} from "#ir/block/planning/layout/index.js";
import type {
  PlannedStateWrite,
  StateWriteId
} from "#ir/block/planning/state-writes.js";
import type { WasmEmittedValue } from "../values/types.js";
import {
  actionEdgesForSite,
  indexLayoutRegions,
  indexStateWrites,
  type LayoutRegionIndex
} from "./regions.js";
import type {
  WasmLayoutActionEdge,
  WasmLayoutDriver,
  WasmLayoutDriverInput
} from "./types.js";

export type {
  WasmActionEffectEmitInput,
  WasmActionEmitter,
  WasmActionInputsEmitInput,
  WasmExitEmitter,
  WasmExitEmitInput,
  WasmLayoutActionEdge,
  WasmLayoutDriver,
  WasmLayoutDriverInput,
  WasmLayoutExitPayload,
  WasmLayoutInputEmitter,
  WasmStateWriteEmitter,
  WasmStateWriteEmitInput
} from "./types.js";

export function emitWasmBlockLayout(input: WasmLayoutDriverInput): void {
  createWasmLayoutDriver(input).emit();
}

export function createWasmLayoutDriver(input: WasmLayoutDriverInput): WasmLayoutDriver {
  return new WasmLayoutDriverState(input);
}

class WasmLayoutDriverState implements WasmLayoutDriver {
  readonly #input: WasmLayoutDriverInput;
  readonly #regions: LayoutRegionIndex;
  readonly #stateWriteById: ReadonlyMap<StateWriteId, PlannedStateWrite>;
  readonly #emittedRegions = new Set<LayoutRegionId>();

  constructor(input: WasmLayoutDriverInput) {
    this.#input = input;
    this.#regions = indexLayoutRegions(input.layout);
    this.#stateWriteById = indexStateWrites(input.stateWrites);
  }

  emit(): void {
    this.#emitRegion(this.#regions.main, undefined);
    this.#assertEveryEdgeRegionWasEmitted();
  }

  #emitRegion(region: LayoutRegion, entryInput: LayoutTimelineInput | undefined): void {
    assert(!this.#emittedRegions.has(region.id), `layout region ${region.id} was emitted more than once`);

    this.#emittedRegions.add(region.id);
    this.#input.cache.enterRegion(region);

    try {
      if (entryInput !== undefined) {
        this.#emitTimelineInput(entryInput);
      }

      for (const step of region.steps) {
        this.#emitStep(step);
      }
    } finally {
      this.#input.cache.leaveRegion(region);
    }
  }

  #emitStep(step: LayoutStep): void {
    switch (step.kind) {
      case "action-inputs":
        this.#input.actions.emitActionInputs({
          site: step.site,
          inputs: step.inputs,
          emitInput: (input) => this.#emitTimelineInput(input)
        });
        return;
      case "establish-snapshot":
        this.#input.cache.ensureSnapshot(
          step.snapshot,
          step.recipe,
          () => this.#input.recipes.emitRecipeBody(step.recipe)
        );
        return;
      case "write-state":
        this.#emitStateWrite(step);
        return;
      case "action":
        this.#input.actions.emitActionEffect({
          site: step.site,
          edges: actionEdgesForSite(step.site, this.#regions, step.inputs),
          emitEdge: (edge) => this.#emitActionEdge(step.site, edge)
        });
        return;
      case "exit":
        this.#input.exits.emitExit({ exit: step.exit });
        return;
    }
  }

  #emitStateWrite(step: Extract<LayoutStep, { kind: "write-state" }>): void {
    const write = this.#writeFor(step.emit);
    const value = step.value;

    const satisfies = step.satisfies.map((writeId) => this.#writeFor(writeId));

    this.#input.stateWriteEmitter.emitStateWrite({
      write,
      satisfies,
      emitValue: () => {
        assert(value !== undefined, `layout state write ${write.id} has no value expression`);
        return this.#emitExprUse(value);
      }
    });
  }

  #emitTimelineInput(input: LayoutTimelineInput): WasmEmittedValue {
    return this.#input.cache.emitUse(
      input,
      () => this.#input.recipes.emitRecipeBody(input.recipe)
    );
  }

  #emitExprUse(input: LayoutExprUse): WasmEmittedValue {
    return this.#input.cache.emitUse(
      input,
      () => this.#input.recipes.emitRecipeBody(input.recipe)
    );
  }

  #emitActionEdge(site: BlockActionSite, edge: WasmLayoutActionEdge): void {
    const allowed = actionEdgesForSite(site, this.#regions, []).some((actionEdge) => actionEdge.edge === edge.edge);

    assert(allowed, `action ${site.action.kind} cannot emit non-owned block edge ${edge.edge}`);

    const edgeRegion = this.#regions.edgeById.get(edge.edge);

    assert(edgeRegion !== undefined, `layout has no region for block edge ${edge.edge}`);
    assert(edgeRegion.exit === edge.exit, `layout edge ${edge.edge} is attached to the wrong exit`);

    this.#emitRegion(
      edgeRegion.region,
      edge.exitPayload.kind === "input" ? edge.exitPayload.input : undefined
    );
  }

  #writeFor(write: StateWriteId): PlannedStateWrite {
    const stateWrite = this.#stateWriteById.get(write);

    assert(stateWrite !== undefined, `layout references missing state write ${write}`);
    return stateWrite;
  }

  #assertEveryEdgeRegionWasEmitted(): void {
    for (const edgeRegion of this.#regions.edgeById.values()) {
      assert(
        this.#emittedRegions.has(edgeRegion.region.id),
        `edge layout region ${edgeRegion.region.id} was not emitted by its owning action`
      );
    }
  }
}
