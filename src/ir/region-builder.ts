import { assert } from "#common/assert.js";
import { CellRef } from "#compiler/refs/cell.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
import type { Action, BranchHint, Finish, LoopCarriedCell } from "./actions.js";
import type { Body, IrBlock } from "./block.js";
import {
  type Operation,
  type OperationWithResult,
  type OperationWithoutResult
} from "#compiler/ir/operations/index.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { joinWidthBounds } from "#compiler/ir/values/width-bounds.js";
import type { ValueId, WidthBounds } from "#compiler/ir/values/types.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";

export type BuildBody = (b: RegionBuilder) => void;
export type BuildResult = (b: RegionBuilder) => ValueId;
export type BodyActionSink = Readonly<{
  push(action: Action): void;
  actions(): readonly Action[];
}>;

export type SwitchArm = Readonly<{ match: number; build: BuildResult }>;

export type IfOptions = Readonly<{
  hint?: BranchHint;
  elseBuild?: BuildBody;
}>;

export type IfValueOptions = Readonly<{
  hint?: BranchHint;
}>;

export class RegionBuilder {
  readonly #sink: BodyActionSink;

  constructor(
    readonly values: ValueTable,
    sink: BodyActionSink = new BufferedBodyActionSink()
  ) {
    this.#sink = sink;
  }

  child(sink: BodyActionSink = new BufferedBodyActionSink()): RegionBuilder {
    return new RegionBuilder(this.values, sink);
  }

  cell(seed: ValueId): CellRef {
    const cell = new CellRef(this.values.valueType(seed));

    this.operation(cellWrite.create({ cell, value: seed, initialization: "seed" }));
    return cell;
  }

  read(cell: CellRef): ValueId {
    return this.operation(cellRead.create({ cell }));
  }

  write(cell: CellRef, value: ValueId): void {
    this.operation(cellWrite.create({ cell, value, initialization: "update" }));
  }

  operation(op: OperationWithoutResult): void;
  operation(op: OperationWithResult): ValueId;
  operation(op: Operation): void | ValueId;
  operation(op: Operation): void | ValueId {
    if (op.result === undefined) {
      this.#emit({ kind: "op", op });
      return;
    }

    const output = op.result.type === "i64"
      ? this.values.addActionOutput64()
      : this.values.addActionOutput(op.result.bounds);

    this.#emit({ kind: "op", op, output });
    return output;
  }

  call(target: FunctionDefinition, args: readonly ValueId[]): readonly ValueId[] {
    const { parameters, results } = target.type;

    assert(
      args.length === parameters.length,
      `function ${target.ref.id} expects ${parameters.length} arguments, got ${args.length}`
    );
    assert(
      results.length <= 1,
      `function ${target.ref.id} has ${results.length} results; multiple call results are not supported yet`
    );
    const inputs = args.map((value, index) => {
      const expected = parameters[index];

      assert(expected !== undefined, `function ${target.ref.id} has no parameter ${index}`);
      const actual = this.values.valueType(value);

      assert(
        actual === expected,
        `function ${target.ref.id} argument ${index} must be ${expected}, got ${actual}`
      );
      return { value, type: expected };
    });
    const outputs = results.map((type) =>
      type === "i64"
        ? this.values.addActionOutput64()
        : this.values.addActionOutput()
    );

    this.#emit({ kind: "call", target, arguments: inputs, outputs });
    return outputs;
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

  ifValue(
    condition: ValueId,
    thenBuild: BuildResult,
    elseBuild: BuildResult,
    options: IfValueOptions = {}
  ): ValueId {
    const thenBody = this.#childResultBody(thenBuild);
    const elseBody = this.#childResultBody(elseBuild);
    const output = this.#addControlOutput([thenBody, elseBody]);

    this.#emit({
      kind: "if",
      condition,
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
      output,
      thenBody,
      elseBody
    });
    return output;
  }

  switch(
    selector: ValueId,
    arms: readonly SwitchArm[],
    defaultBuild: BuildResult
  ): ValueId {
    const cases = arms.map(({ match, build }) => ({ match, body: this.#childResultBody(build) }));
    const defaultBody = this.#childResultBody(defaultBuild);
    const output = this.#addControlOutput([
      ...cases.map((entry) => entry.body),
      defaultBody
    ]);

    this.#emit({ kind: "switch", selector, output, cases, defaultBody });
    return output;
  }

  // Terminates this body: fault arms, trap arms, the root.
  finish(finish: Finish): void {
    this.#emit({ kind: "finish", finish });
  }

  return(results: readonly ValueId[]): void {
    this.#emit({ kind: "return", results: [...results] });
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
    const child = this.child();

    build(child);
    return child.build();
  }

  #childResultBody(build: BuildResult): Body {
    const child = this.child();
    const result = build(child);

    return child.build(result);
  }

  #addControlOutput(bodies: readonly Body[]): ValueId {
    const bounds: WidthBounds[] = [];

    for (const body of bodies) {
      const result = body.result;

      assert(result !== undefined, "value-producing control body has no result");
      assert(
        this.values.valueType(result) === "i32",
        "only i32 control results are supported"
      );
      if (!this.values.isUnreachable(result)) {
        bounds.push(this.values.widthBounds(result));
      }
    }

    return this.values.addActionOutput(joinWidthBounds(bounds));
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

export function buildIrBlock(build: (b: RegionBuilder) => ValueId | void): IrBlock {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const result = build(builder);

  return { values, body: builder.build(result ?? undefined) };
}
