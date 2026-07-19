import { assert } from "#common/assert.js";
import {
  wasmBranchHint,
  type WasmBranchHint
} from "#compiler/encoder/function-body.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Body } from "#ir/block.js";
import type {
  BodyCompletionContext,
  NestedBody,
  ValueUseEmitter
} from "#ir/node.js";
import {
  ControlBase,
  type ControlEmitTarget
} from "./definition.js";

export type BranchHint = "unlikely" | "likely";

export type IfControlArgs = Readonly<{
  condition: ValueId;
  hint?: BranchHint;
  output?: ValueId;
  thenBody: Body;
  elseBody?: Body;
}>;

export class IfControl extends ControlBase {
  static readonly kind = "if";
  readonly kind = IfControl.kind;
  readonly condition: ValueId;
  declare readonly hint?: BranchHint;
  declare readonly output?: ValueId;
  readonly thenBody: Body;
  declare readonly elseBody?: Body;
  readonly operands: readonly [ValueId];
  readonly nestedBodies: readonly NestedBody[];
  readonly outputs: readonly ValueId[];

  private constructor({
    condition,
    hint,
    output,
    thenBody,
    elseBody
  }: IfControlArgs) {
    super();
    this.condition = condition;
    if (hint !== undefined) {
      this.hint = hint;
    }
    if (output !== undefined) {
      this.output = output;
    }
    this.thenBody = thenBody;
    if (elseBody !== undefined) {
      this.elseBody = elseBody;
    }
    this.operands = [condition];
    const thenEntry = nestedBody(thenBody, "thenBody");
    this.nestedBodies = elseBody === undefined
      ? [thenEntry]
      : [thenEntry, nestedBody(elseBody, "elseBody")];
    this.outputs = output === undefined ? [] : [output];
  }

  static create(args: IfControlArgs): IfControl {
    return new IfControl(args);
  }

  completes(context: BodyCompletionContext): boolean {
    return ifCompletes(this.thenBody, this.elseBody, context);
  }

  mapBodies(map: (body: Body) => Body): IfControl {
    return IfControl.create({
      condition: this.condition,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.output === undefined ? {} : { output: this.output }),
      thenBody: map(this.thenBody),
      ...(this.elseBody === undefined ? {} : { elseBody: map(this.elseBody) })
    });
  }

  emit(target: ControlEmitTarget, values: ValueUseEmitter): void {
    const {
      condition,
      thenBody,
      elseBody,
      output,
      hint
    } = this;
    const outputLocal = output === undefined
      ? undefined
      : target.controlOutputLocal(output);

    values.emitUse(condition);
    target.emitCaptures();
    target.body.ifBlock({ hint: wasmHint(hint) });
    target.withNestedControl(() => {
      target.emitBody(thenBody, outputLocal);

      if (elseBody !== undefined) {
        target.body.elseBlock();
        target.emitBody(elseBody, outputLocal);
      } else {
        assert(output === undefined, "value-producing if has no else body");
      }
    });
    target.body.endBlock();

    if (output !== undefined && outputLocal !== undefined) {
      target.markControlOutput(output);
    }
    if (ifCompletes(thenBody, elseBody, target)) {
      target.sealCompletedStructuredControl();
    }
  }
}

export const ifControl = IfControl;

function ifCompletes(
  thenBody: Body,
  elseBody: Body | undefined,
  context: BodyCompletionContext
): boolean {
  return elseBody !== undefined &&
    context.bodyCompletes(thenBody) &&
    context.bodyCompletes(elseBody);
}

function nestedBody(body: Body, role: string): NestedBody {
  return { body, role, scope: { kind: "ordinary" } };
}

function wasmHint(hint: BranchHint | undefined): WasmBranchHint | undefined {
  switch (hint) {
    case undefined:
      return undefined;
    case "unlikely":
      return wasmBranchHint.unlikely;
    case "likely":
      return wasmBranchHint.likely;
  }
}
