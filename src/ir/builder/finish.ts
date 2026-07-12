import { assert } from "#common/assert.js";
import type { CpuException } from "#core/exceptions.js";
import type { BodyBuilder } from "../body-builder.js";
import type { Finish, StateWriteAction } from "../actions.js";
import type { StatePathKind } from "./state/pending-buffer.js";
import type { State } from "./state/index.js";
import type { ValueId } from "../values.js";
import type { SemanticScopeStack } from "./scope.js";

// The one place a body ends: the exit path's state flushes, then the Finish.
// x86 exit policy (exceptions, traps, dispatch) lives here.
export class FinishEmitter {
  readonly #state: State;
  readonly #scopes: SemanticScopeStack;

  constructor(state: State, scopes: SemanticScopeStack) {
    this.#state = state;
    this.#scopes = scopes;
  }

  finishBody(body: BodyBuilder, finish: Finish, path: StatePathKind): void {
    this.#finishBodyWith(body, finish, this.#state.flushesForPath(path));
  }

  finishCurrentBody(finish: Finish, path: StatePathKind): void {
    this.finishBody(this.#scopes.current.body, finish, path);
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
