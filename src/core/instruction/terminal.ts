import { assert } from "#common/assert.js";
import type { CpuException } from "#core/exceptions.js";
import {
  exceptionExit,
  segmentExit,
  trapExit
} from "#core/exits.js";
import {
  resourceWrite,
  type ResourceWriteArgs
} from "#compiler/ir/operations/resource.js";
import type { RegionBuilder } from "#ir/region-builder.js";
import type { StatePathKind } from "./state/pending-buffer.js";
import type { InstructionState } from "./state/state.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { VariantValue } from "#compiler/layout/variant-codec.js";

export type BuildExit = (
  values: ValueTable,
  exit: VariantValue<ValueId>
) => ValueId;

export type InstructionTerminals = Readonly<{
  dispatch(region: RegionBuilder, targetEip: ValueId): void;
  returnExit(region: RegionBuilder, result: ValueId): void;
}>;

// Core settles architectural state before handing a path to the enclosing
// symbolic frontend. The terminal only chooses its outer control representation;
// it cannot change completion or restart policy.
export class InstructionTerminator {
  readonly #state: InstructionState;
  readonly #buildExit: BuildExit;
  readonly #terminals: InstructionTerminals;

  constructor(
    state: InstructionState,
    buildExit: BuildExit,
    terminals: InstructionTerminals
  ) {
    this.#state = state;
    this.#buildExit = buildExit;
    this.#terminals = terminals;
  }

  cpuException(
    region: RegionBuilder,
    access: BoundStateAccess,
    exception: CpuException<ValueId>
  ): void {
    this.#exit(
      region,
      access,
      this.#buildExit(
        region.values,
        exceptionExit(exception)
      ),
      "fault"
    );
  }

  dispatch(
    region: RegionBuilder,
    access: BoundStateAccess,
    targetEip: ValueId
  ): void {
    this.publishCompletedState(region, access);
    this.#terminals.dispatch(region, targetEip);
  }

  publishCompletedState(
    region: RegionBuilder,
    access: BoundStateAccess
  ): void {
    assert(this.#state.eip.has(), "completion requires a completed pending eip");
    this.#emitWritebacks(region, this.#state.flushesForPath(access, "completed"));
  }

  hostTrap(
    region: RegionBuilder,
    access: BoundStateAccess,
    vector: ValueId
  ): void {
    this.#exit(
      region,
      access,
      this.#buildExit(region.values, trapExit(vector)),
      "completed"
    );
  }

  segmentLoad(
    region: RegionBuilder,
    access: BoundStateAccess,
    segment: ValueId,
    selector: ValueId
  ): void {
    this.#exit(
      region,
      access,
      this.#buildExit(region.values, segmentExit(segment, selector)),
      "fault"
    );
  }

  #exit(
    region: RegionBuilder,
    access: BoundStateAccess,
    result: ValueId,
    path: StatePathKind
  ): void {
    this.#emitWritebacks(region, this.#state.flushesForPath(access, path));
    this.#terminals.returnExit(region, result);
  }

  #emitWritebacks(
    region: RegionBuilder,
    writebacks: readonly ResourceWriteArgs[]
  ): void {
    for (const writeback of writebacks) {
      region.operation(resourceWrite, writeback);
    }
  }
}
