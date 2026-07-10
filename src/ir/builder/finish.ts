import { assert } from "#common/assert.js";
import {
  pageFault,
  pageFaultErrorCode,
  type CpuException
} from "#x86/exceptions.js";
import type { BodyBuilder } from "../body-builder.js";
import type { Finish, StateWriteAction } from "../actions.js";
import type { MemoryAccessKind } from "../ops.js";
import type { StatePathKind } from "./state/pending-buffer.js";
import type { State } from "./state/index.js";
import type { ValueId } from "../values.js";
import type { ControlEmitter } from "./control.js";
import type { SemanticScopeStack } from "./scope.js";

// The one place a body ends: the exit path's state flushes, then the Finish.
// x86 exit policy (exceptions, traps, dispatch) lives here.
export class FinishEmitter {
  readonly #state: State;
  readonly #scopes: SemanticScopeStack;
  readonly #control: ControlEmitter;

  constructor(state: State, scopes: SemanticScopeStack, control: ControlEmitter) {
    this.#state = state;
    this.#scopes = scopes;
    this.#control = control;
  }

  finishBody(body: BodyBuilder, finish: Finish, path: StatePathKind): void {
    this.#finishBodyWith(body, finish, this.#state.flushesForPath(path));
  }

  finishCurrentBody(finish: Finish, path: StatePathKind): void {
    this.finishBody(this.#scopes.current.body, finish, path);
  }

  guardIf(address: ValueId, byteLength: ValueId, access: MemoryAccessKind): void {
    const fault = this.#scopes.current.body.opValue({
      kind: "memory.check",
      address,
      byteLength,
      access
    });

    this.faultIf(fault, pageFault(address, pageFaultErrorCode(access === "write" ? "dataWrite" : "dataRead")));
  }

  faultIf(condition: ValueId, exception: CpuException<ValueId>): void {
    assert(
      this.#scopes.current.body.values.constValue(condition) === undefined,
      "constant fault conditions are unsupported"
    );
    this.#control.if(
      condition,
      (faultBody) => this.finishBody(
        faultBody,
        { kind: "exit", exit: { class: "cpuException", exception } },
        "fault"
      ),
      "unlikely"
    );
  }

  cpuException(exception: CpuException<ValueId>): void {
    this.finishCurrentBody({ kind: "exit", exit: { class: "cpuException", exception } }, "fault");
  }

  dispatch(body: BodyBuilder, targetEip: ValueId): void {
    assert(!this.#state.eip.has(), "dispatch requires the pending eip to be consumed");
    this.#finishBodyWith(
      body,
      { kind: "dispatch", targetEip },
      this.#state.flushesForPath("completed")
    );
  }

  hostTrap(vector: ValueId): void {
    this.finishCurrentBody(hostTrapFinish(vector), "completed");
  }

  #finishBodyWith(body: BodyBuilder, finish: Finish, flushes: readonly StateWriteAction[]): void {
    for (const action of flushes) {
      body.push(action);
    }

    body.finish(finish);
  }
}

function hostTrapFinish(vector: ValueId): Finish {
  return { kind: "exit", exit: { class: "host", reason: "hostTrap", payload: vector } };
}
