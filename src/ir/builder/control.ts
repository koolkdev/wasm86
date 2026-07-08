import { assert } from "#common/assert.js";
import { type BranchHint, bodyCompletes } from "../actions.js";
import type { Body } from "../block.js";
import { BodyBuilder, type BuildBody } from "../body-builder.js";
import type { ValueId } from "../values.js";
import type { State } from "./state/index.js";

export type RunInBody = (body: BodyBuilder, build: BuildBody) => void;

export class ControlEmitter {
  readonly #state: State;
  readonly #currentBody: () => BodyBuilder;
  readonly #runInBody: RunInBody;

  constructor(state: State, currentBody: () => BodyBuilder, runInBody: RunInBody) {
    this.#state = state;
    this.#currentBody = currentBody;
    this.#runInBody = runInBody;
  }

  if(condition: ValueId, thenBuild: BuildBody, hint?: BranchHint): void {
    const parent = this.#currentBody();
    const thenBody = this.#scopedBody(thenBuild);

    parent.push({
      kind: "if",
      condition,
      ...(hint !== undefined ? { hint } : {}),
      thenBody
    });
  }

  #scopedBody(build: BuildBody): Body {
    let body: Body | undefined;

    this.#state.enterScope(() => {
      const child = new BodyBuilder(this.#currentBody().values);

      this.#runInBody(child, build);
      body = child.build();
      return bodyCompletes(body);
    });

    assert(body !== undefined, "state-scoped control body was not built");
    return body;
  }
}
