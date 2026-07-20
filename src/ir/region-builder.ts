import { assert } from "#common/assert.js";
import { CellRef } from "#compiler/refs/cell.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import {
  IndirectCallTarget,
  Invocation,
  type CallTarget
} from "#compiler/ir/invocation.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
import { callOperation } from "#compiler/ir/operations/call.js";
import {
  finishControl,
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl,
  type BranchHint,
  type Finish,
  type LoopCarriedCell
} from "#compiler/ir/controls/index.js";
import type { Body, BodyNode, IrBlock } from "./block.js";
import {
  type Operation,
  type OperationFactory,
  type OperationResult
} from "#compiler/ir/operations/index.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { joinWidthBounds } from "#compiler/ir/values/width-bounds.js";
import type {
  ValueId,
  ValueType,
  WidthBounds
} from "#compiler/ir/values/types.js";
import type { FunctionType } from "#compiler/program/function-type.js";
import type { TableRef } from "#compiler/program/refs.js";

export type BuildBody = (b: RegionBuilder) => void;
export type BuildResult = (b: RegionBuilder) => ValueId;
export type BodyNodeSink = Readonly<{
  push(node: BodyNode): void;
  nodes(): readonly BodyNode[];
}>;

export type SwitchArm = Readonly<{ match: number; build: BuildResult }>;
export type SwitchControlArm = Readonly<{
  matches: readonly number[];
  build: BuildBody;
}>;

export type IfOptions = Readonly<{
  hint?: BranchHint;
  elseBuild?: BuildBody;
}>;

export type IfValueOptions = Readonly<{
  hint?: BranchHint;
}>;

export type IndirectTargetArgs = Readonly<{
  table: TableRef;
  type: FunctionType;
  effects: StorageEffects;
  elementIndex: ValueId;
}>;

export class RegionBuilder {
  readonly #sink: BodyNodeSink;
  readonly #functionResults: readonly ValueType[] | undefined;

  constructor(
    readonly values: ValueTable,
    sink: BodyNodeSink = new BufferedBodyNodeSink(),
    functionResults: readonly ValueType[] | undefined = undefined
  ) {
    this.#sink = sink;
    this.#functionResults = functionResults;
  }

  child(sink: BodyNodeSink = new BufferedBodyNodeSink()): RegionBuilder {
    return new RegionBuilder(this.values, sink, this.#functionResults);
  }

  cell(seed: ValueId): CellRef {
    const cell = new CellRef(this.values.valueType(seed));

    this.operation(cellWrite, { cell, value: seed, initialization: "seed" });
    return cell;
  }

  read(cell: CellRef): ValueId {
    return this.operation(cellRead, { cell });
  }

  write(cell: CellRef, value: ValueId): void {
    this.operation(cellWrite, { cell, value, initialization: "update" });
  }

  operation<
    CreateArgs,
    Entry extends Operation & { readonly results: readonly [OperationResult] }
  >(
    factory: OperationFactory<CreateArgs, Entry>,
    args: CreateArgs
  ): ValueId;
  operation<
    CreateArgs,
    Entry extends Operation & { readonly results: readonly [] }
  >(
    factory: OperationFactory<CreateArgs, Entry>,
    args: CreateArgs
  ): void;
  operation<
    CreateArgs,
    Entry extends Operation
  >(
    factory: OperationFactory<CreateArgs, Entry>,
    args: CreateArgs
  ): void | ValueId {
    const operation = factory.create(
      args,
      (result) => this.#allocateOperationOutput(result)
    );
    const outputs = operation.outputs;

    this.#emit(operation);

    if (outputs.length === 0) {
      return;
    }

    assert(outputs.length === 1, `${factory.kind} has unsupported multiple results`);
    return outputs[0];
  }

  indirectTarget(args: IndirectTargetArgs): IndirectCallTarget {
    return IndirectCallTarget.create({
      table: args.table,
      type: args.type,
      effects: args.effects,
      elementIndex: {
        value: args.elementIndex,
        type: this.values.valueType(args.elementIndex)
      }
    });
  }

  call(target: CallTarget, args: readonly ValueId[]): readonly ValueId[] {
    const invocation = this.#invocation(target, args);
    const operation = callOperation.create(
      { invocation },
      (result) => this.#allocateOperationOutput(result)
    );

    this.#emit(operation);
    return operation.outputs;
  }

  returnCall(target: CallTarget, args: readonly ValueId[]): void {
    const functionResults = this.#functionResults;

    assert(functionResults !== undefined, "returnCall requires an enclosing function");
    const invocation = this.#invocation(target, args);
    const results = invocation.target.type.results;

    assert(
      results.length === functionResults.length &&
        results.every((type, index) => type === functionResults[index]),
      "call results do not match the enclosing function"
    );

    this.#emit(returnControl.create({
      source: { kind: "invocation", invocation }
    }));
  }

  // Escape hatch for an already-built body node.
  push(node: BodyNode): void {
    this.#emit(node);
  }

  extend(nodes: readonly BodyNode[]): void {
    for (const node of nodes) {
      this.push(node);
    }
  }

  if(condition: ValueId, thenBuild: BuildBody, options: IfOptions = {}): void {
    const thenBody = this.#childBody(thenBuild);
    const elseBody = options.elseBuild === undefined ? undefined : this.#childBody(options.elseBuild);

    this.#emit(ifControl.create({
      condition,
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
      thenBody,
      ...(elseBody !== undefined ? { elseBody } : {})
    }));
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

    this.#emit(ifControl.create({
      condition,
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
      output,
      thenBody,
      elseBody
    }));
    return output;
  }

  switch(
    selector: ValueId,
    arms: readonly SwitchArm[],
    defaultBuild: BuildResult
  ): ValueId {
    const cases = arms.map(({ match, build }) => ({
      matches: [match],
      body: this.#childResultBody(build)
    }));
    const defaultBody = this.#childResultBody(defaultBuild);
    const output = this.#addControlOutput([
      ...cases.map((entry) => entry.body),
      defaultBody
    ]);

    this.#emit(switchControl.create({ selector, output, cases, defaultBody }));
    return output;
  }

  switchControl(
    selector: ValueId,
    arms: readonly SwitchControlArm[],
    defaultBuild: BuildBody
  ): void {
    for (const [index, arm] of arms.entries()) {
      assert(arm.matches.length > 0, `control-only switch arm ${index} has no matches`);
    }
    const cases = arms.map(({ matches, build }) => ({
      matches,
      body: this.#childBody(build)
    }));
    const defaultBody = this.#childBody(defaultBuild);

    this.#emit(switchControl.create({ selector, cases, defaultBody }));
  }

  // Terminates this body: fault arms, trap arms, the root.
  finish(finish: Finish): void {
    this.#emit(finishControl.create({ finish }));
  }

  return(results: readonly ValueId[]): void {
    this.#emit(returnControl.create({
      source: { kind: "values", values: results }
    }));
  }

  loop(carried: readonly LoopCarriedCell[], bodyBuild: BuildBody): void {
    this.#emit(loopControl.create({ carried, body: this.#childBody(bodyBuild) }));
  }

  // The back edge of the enclosing loop; usually sits under an if arm.
  loopContinue(updates: readonly ValueId[]): void {
    this.#emit(loopContinueControl.create({ updates }));
  }

  build(result?: ValueId): Body {
    const nodes = this.#sink.nodes();

    return result === undefined ? { nodes } : { nodes, result };
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

    return this.values.addNodeOutput(joinWidthBounds(bounds));
  }

  #allocateOperationOutput(result: OperationResult): ValueId {
    return result.type === "i64"
      ? this.values.addNodeOutput64()
      : this.values.addNodeOutput(result.bounds);
  }

  #invocation(
    target: CallTarget,
    args: readonly ValueId[]
  ): Invocation {
    return Invocation.create({
      target,
      arguments: args.map((value) => ({
        value,
        type: this.values.valueType(value)
      }))
    });
  }

  #emit(node: BodyNode): void {
    this.#sink.push(node);
  }
}

class BufferedBodyNodeSink implements BodyNodeSink {
  readonly #nodes: BodyNode[] = [];

  push(node: BodyNode): void {
    this.#nodes.push(node);
  }

  nodes(): readonly BodyNode[] {
    return this.#nodes;
  }
}

export function buildIrBlock(build: (b: RegionBuilder) => ValueId | void): IrBlock {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const result = build(builder);

  return { values, body: builder.build(result ?? undefined) };
}
