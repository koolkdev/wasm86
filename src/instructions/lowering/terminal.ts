import { assert } from "#common/assert.js";
import type { CpuException } from "#core/exceptions.js";
import { exceptionExit, segmentExit, trapExit } from "#core/exits.js";
import { type I32Value, type I64Value } from "#compiler/function/values.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { StatePathKind } from "./state/pending-buffer.js";
import type { InstructionState } from "./state/state.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { VariantValue } from "#compiler/layout/variant-codec.js";
import type { StateWriteback } from "./state/writeback.js";

export type BuildExit = (exit: VariantValue<I32Value>) => I64Value;

export type InstructionTerminals = Readonly<{
  dispatch(region: RegionBuilder, targetEip: I32Value): void;
  returnExit(region: RegionBuilder, result: I64Value): void;
}>;

// Core settles architectural state before handing a path to the enclosing
// symbolic frontend. The terminal only chooses its outer control representation;
// it cannot change completion or restart policy.
export class InstructionTerminator {
  readonly #state: InstructionState;
  readonly #buildExit: BuildExit;
  readonly #terminals: InstructionTerminals;

  constructor(state: InstructionState, buildExit: BuildExit, terminals: InstructionTerminals) {
    this.#state = state;
    this.#buildExit = buildExit;
    this.#terminals = terminals;
  }

  cpuException(
    region: RegionBuilder,
    access: BoundStateAccess,
    exception: CpuException<I32Value>
  ): void {
    this.#exit(region, access, this.#buildExit(exceptionExit(exception)), "fault");
  }

  dispatch(region: RegionBuilder, access: BoundStateAccess, targetEip: I32Value): void {
    this.publishCompletedState(region, access);
    this.#terminals.dispatch(region, targetEip);
  }

  publishCompletedState(region: RegionBuilder, access: BoundStateAccess): void {
    assert(this.#state.eip.has(), "completion requires a completed pending eip");
    this.#emitWritebacks(region, this.#state.flushesForPath(access, "completed"));
  }

  hostTrap(region: RegionBuilder, access: BoundStateAccess, vector: I32Value): void {
    this.#exit(region, access, this.#buildExit(trapExit(vector)), "completed");
  }

  segmentLoad(
    region: RegionBuilder,
    access: BoundStateAccess,
    segment: I32Value,
    selector: I32Value
  ): void {
    this.#exit(region, access, this.#buildExit(segmentExit(segment, selector)), "fault");
  }

  #exit(
    region: RegionBuilder,
    access: BoundStateAccess,
    result: I64Value,
    path: StatePathKind
  ): void {
    this.#emitWritebacks(region, this.#state.flushesForPath(access, path));
    this.#terminals.returnExit(region, result);
  }

  #emitWritebacks(region: RegionBuilder, writebacks: readonly StateWriteback[]): void {
    for (const writeback of writebacks) {
      writeback.emit(region);
    }
  }
}
