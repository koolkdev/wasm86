import type { ValueInput } from "#instructions/semantics/refs.js";
import { type InstructionStateChannel } from "./state/channels.js";
import type { ResourceEffect } from "#compiler/ir/resource.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import type { RegionNode } from "#compiler/ir/region.js";
import { RegionBuilder, type RegionNodeSink } from "#compiler/ir/builder/region.js";
import type { InstructionState } from "./state/state.js";
import {
  StateLoopScope,
  type LoopCarriedState
} from "./state/loop-scope.js";

export type LoopBuilderContext = Readonly<{
  state: InstructionState;
  parentRegion: RegionBuilder;
}>;

// One loop under construction: the carried state, entry-hoisted operations,
// the body's node sink, and the accesses the scope polices.
export class LoopBuilder {
  readonly #parent: RegionBuilder;
  readonly #state: InstructionState;
  readonly #carried: readonly LoopCarriedState[];
  readonly #scope: StateLoopScope;
  readonly #bodySink: LoopBodySink;
  readonly #region: RegionBuilder;

  private constructor(
    context: LoopBuilderContext,
    carried: readonly LoopCarriedState[],
    scope: StateLoopScope
  ) {
    this.#parent = context.parentRegion;
    this.#state = context.state;
    this.#carried = carried;
    this.#scope = scope;
    this.#bodySink = new LoopBodySink(scope);
    this.#region = context.parentRegion.child(this.#bodySink);
  }

  get region(): RegionBuilder {
    return this.#region;
  }

  static begin(context: LoopBuilderContext, bodyWrites: readonly InstructionStateChannel[]): LoopBuilder {
    const scope = new StateLoopScope(
      context.parentRegion.values,
      context.state,
      bodyWrites
    );

    return new LoopBuilder(
      context,
      scope.begin(context.state.bind(context.parentRegion)),
      scope
    );
  }

  // Close while the semantic loop scope is current: state resolution belongs
  // in the loop body. The back edge and exit tail share one value capture.
  close(condition: ValueInput): void {
    const access = this.#state.bind(this.#region);
    const exitValues = this.#scope.captureExitValues(access);

    this.#region.if(condition, (taken) => taken.loopContinue(exitValues));

    // The exit path's one commit per carried channel.
    for (const writeback of this.#scope.exitWritebacks(access, exitValues)) {
      this.#region.operation(resourceWrite, writeback);
    }

    this.#parent.extend(this.#bodySink.entryOperations());
    this.#parent.loop(
      this.#carried.map(({ seed, loopInput }) => ({ seed, loopInput })),
      (body) => body.extend(this.#region.build().nodes)
    );
    this.#scope.close();
  }
}

class LoopBodySink implements RegionNodeSink {
  readonly #scope: StateLoopScope;
  readonly #entryOperations: Operation[] = [];
  readonly #bodyNodes: RegionNode[] = [];

  constructor(scope: StateLoopScope) {
    this.#scope = scope;
  }

  push(node: RegionNode): void {
    if (node.category !== "operation") {
      this.#bodyNodes.push(node);
      return;
    }

    const read = loopInvariantResourceRead(node);

    if (read !== undefined && this.#scope.isExecutionStateEffect(read)) {
      // Dynamic GPR reads flush tracked GPR state - asserted away at their
      // call sites; a dynamic segment base is loop-invariant like any static
      // non-carried channel, since segment loads are rejected inside loop
      // bodies and end the block outside them.
      this.#scope.assertHoistableRead(read);
      this.#entryOperations.push(node);
      return;
    }

    this.#bodyNodes.push(node);
  }

  nodes(): readonly RegionNode[] {
    return this.#bodyNodes;
  }

  entryOperations(): readonly Operation[] {
    return this.#entryOperations;
  }
}

// Loop-entry hoisting explicitly recognizes resource reads. A new operation
// cannot become movable merely by declaring the same effect shape.
function loopInvariantResourceRead(operation: Operation): ResourceEffect | undefined {
  if (operation.kind !== resourceRead.kind) {
    return undefined;
  }

  return operation.source.effect;
}
