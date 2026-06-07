import { assert } from "#common/assert.js";
import type { BlockActionSite } from "#ir/block/timeline.js";
import type { BlockEdgeId } from "#ir/block/planning/geometry/index.js";
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
  WasmLayoutDriver,
  WasmLayoutDriverInput
} from "./types.js";

export type {
  WasmActionEffectEmitInput,
  WasmActionEmitter,
  WasmActionInputsEmitInput,
  WasmDefinitionEmitter,
  WasmDefinitionEmitInput,
  WasmExitEmitter,
  WasmExitEmitInput,
  WasmLayoutActionEdge,
  WasmLayoutDriver,
  WasmLayoutDriverInput,
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
    this.#emitRegion(this.#regions.main);
    this.#assertEveryEdgeRegionWasEmitted();
  }

  #emitRegion(region: LayoutRegion): void {
    assert(!this.#emittedRegions.has(region.id), `layout region ${region.id} was emitted more than once`);

    this.#emittedRegions.add(region.id);
    this.#input.cache.enterRegion(region);

    try {
      for (const step of region.steps) {
        this.#emitStep(step);
      }
    } finally {
      this.#input.cache.leaveRegion(region);
    }
  }

  #emitStep(step: LayoutStep): void {
    switch (step.kind) {
      case "definition":
        this.#input.definitions.emitDefinition({
          site: step.site,
          inputs: step.inputs,
          emitInput: (input) => this.#emitTimelineInput(input)
        });
        return;
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
          inputs: step.inputs,
          edges: actionEdgesForSite(step.site, this.#regions),
          emitInput: (input) => this.#emitTimelineInput(input),
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

    this.#input.stateWriteEmitter.emitStateWrite({
      write,
      satisfies: step.satisfies.map((writeId) => this.#writeFor(writeId)),
      ...(value === undefined
        ? {}
        : { emitValue: () => this.#emitExprUse(value) })
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

  #emitActionEdge(site: BlockActionSite, edge: BlockEdgeId): void {
    const allowed = actionEdgesForSite(site, this.#regions).some((actionEdge) => actionEdge.edge === edge);

    assert(allowed, `action ${site.action.kind} cannot emit non-owned block edge ${edge}`);

    const edgeRegion = this.#regions.edgeById.get(edge);

    assert(edgeRegion !== undefined, `layout has no region for block edge ${edge}`);

    this.#emitRegion(edgeRegion.region);
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
