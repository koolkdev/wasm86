import { assert } from "#common/assert.js";
import type { Action, BranchHint, Finish, LoopCarriedCell } from "./actions.js";
import type { Body, IrBlock } from "./block.js";
import { opAccess, type IrOp } from "./ops.js";
import { ValueTable, type ValueId, type WidthBounds } from "./values.js";

export type BuildBody = (b: BodyBuilder) => void;
export type BuildResult = (b: BodyBuilder) => ValueId;
export type BodyActionSink = Readonly<{
  push(action: Action): void;
  actions(): readonly Action[];
}>;

export type SwitchArm = Readonly<{ match: number; build: BuildResult }>;

export type IfOptions = Readonly<{
  hint?: BranchHint;
  elseBuild?: BuildBody;
}>;

export class BodyBuilder {
  readonly #sink: BodyActionSink;

  constructor(readonly values: ValueTable, sink: BodyActionSink = new BufferedBodyActionSink()) {
    this.#sink = sink;
  }

  // Schedules an op with no value output (memory.write, state.write, ...).
  op(op: IrOp): void {
    assert(opAccess(op).valueOutput === undefined, `${op.kind} op has an output; emit it with opValue`);
    this.#emit({ kind: "op", op });
  }

  // Schedules an op that produces a value; returns that value.
  opValue(op: IrOp): ValueId {
    const valueOutput = opAccess(op).valueOutput;

    assert(valueOutput !== undefined, `${op.kind} op has no output; emit it with op`);
    assert(valueOutput.type === "i32", `${op.kind} op action output type is not supported`);

    const output = this.values.addActionOutput(valueOutput.bounds);

    this.#emit({ kind: "op", op, output });
    return output;
  }

  // Escape hatch for an already-built action.
  push(action: Action): void {
    this.#emit(action);
  }

  extend(actions: readonly Action[]): void {
    for (const action of actions) {
      this.push(action);
    }
  }

  if(condition: ValueId, thenBuild: BuildBody, options: IfOptions = {}): void {
    const thenBody = this.#childBody(thenBuild);
    const elseBody = options.elseBuild === undefined ? undefined : this.#childBody(options.elseBuild);

    this.#emit({
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

    this.#emit({ kind: "switch", selector, output, cases, defaultBody });
    return output;
  }

  // Terminates this body: fault arms, trap arms, the root.
  finish(finish: Finish): void {
    this.#emit({ kind: "finish", finish });
  }

  loop(carried: readonly LoopCarriedCell[], bodyBuild: BuildBody): void {
    this.#emit({ kind: "loop", carried, body: this.#childBody(bodyBuild) });
  }

  // The back edge of the enclosing loop; usually sits under an if arm.
  loopContinue(updates: readonly ValueId[]): void {
    this.#emit({ kind: "loopContinue", updates });
  }

  build(result?: ValueId): Body {
    const actions = this.#sink.actions();

    return result === undefined ? { actions } : { actions, result };
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

  #emit(action: Action): void {
    this.#sink.push(action);
  }
}

class BufferedBodyActionSink implements BodyActionSink {
  readonly #actions: Action[] = [];

  push(action: Action): void {
    this.#actions.push(action);
  }

  actions(): readonly Action[] {
    return this.#actions;
  }
}

export function buildIrBlock(build: (b: BodyBuilder) => ValueId | void): IrBlock {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const result = build(builder);

  return { values, body: builder.build(result ?? undefined) };
}
