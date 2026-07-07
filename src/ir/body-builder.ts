import { assert } from "#common/assert.js";
import type { Action, BranchHint, Finish, LoopCarriedCell } from "./actions.js";
import type { Body, IrBlock } from "./block.js";
import { opAccess, type IrOp } from "./ops.js";
import { ValueTable, type ValueId, type WidthBounds } from "./values.js";

export type BuildBody = (b: BodyBuilder) => void;
export type BuildResult = (b: BodyBuilder) => ValueId;

export type SwitchArm = Readonly<{ match: number; build: BuildResult }>;

export type IfOptions = Readonly<{
  hint?: BranchHint;
  elseBuild?: BuildBody;
}>;

export class BodyBuilder {
  readonly #actions: Action[] = [];

  constructor(readonly values: ValueTable) {}

  // Schedules an op that produces a value; returns that value.
  op(op: IrOp): ValueId {
    const valueOutput = opAccess(op).valueOutput;

    assert(valueOutput !== undefined, `${op.kind} op has no output; emit it with effect`);
    assert(valueOutput.type === "i32", `${op.kind} op action output type is not supported`);

    const output = this.values.addActionOutput(valueOutput.bounds);

    this.#actions.push({ kind: "op", op, output });
    return output;
  }

  // Schedules an op that only affects state (memory.write, state.write, ...).
  effect(op: IrOp): void {
    assert(opAccess(op).valueOutput === undefined, `${op.kind} op has an output; emit it with op`);
    this.#actions.push({ kind: "op", op });
  }

  // Escape hatch for an already-built action.
  push(action: Action): void {
    this.#actions.push(action);
  }

  if(condition: ValueId, thenBuild: BuildBody, options: IfOptions = {}): void {
    const thenBody = this.#childBody(thenBuild);
    const elseBody = options.elseBuild === undefined ? undefined : this.#childBody(options.elseBuild);

    this.#actions.push({
      kind: "if",
      condition,
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
      thenBody,
      ...(elseBody !== undefined ? { elseBody } : {})
    });
  }

  switch(
    selector: ValueId,
    arms: readonly SwitchArm[],
    defaultBuild: BuildResult,
    outputBounds?: WidthBounds
  ): ValueId {
    const cases = arms.map(({ match, build }) => ({ match, body: this.#childResultBody(build) }));
    const defaultBody = this.#childResultBody(defaultBuild);
    const output = this.values.addActionOutput(outputBounds);

    this.#actions.push({ kind: "switch", selector, output, cases, defaultBody });
    return output;
  }

  // Terminates this body: fault arms, trap arms, the root.
  finish(finish: Finish): void {
    this.#actions.push({ kind: "finish", finish });
  }

  loop(carried: readonly LoopCarriedCell[], bodyBuild: BuildBody): void {
    this.#actions.push({ kind: "loop", carried, body: this.#childBody(bodyBuild) });
  }

  // The back edge of the enclosing loop; usually sits under an if arm.
  loopContinue(updates: readonly ValueId[]): void {
    this.#actions.push({ kind: "loopContinue", updates });
  }

  build(result?: ValueId): Body {
    return result === undefined ? { actions: this.#actions } : { actions: this.#actions, result };
  }

  #childBody(build: BuildBody): Body {
    const child = new BodyBuilder(this.values);

    build(child);
    return child.build();
  }

  #childResultBody(build: BuildResult): Body {
    const child = new BodyBuilder(this.values);
    const result = build(child);

    return child.build(result);
  }
}

export function buildIrBlock(build: (b: BodyBuilder) => ValueId | void): IrBlock {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const result = build(builder);

  return { values, body: builder.build(result ?? undefined) };
}
