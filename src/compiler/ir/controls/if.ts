import type { ValueId } from "#compiler/ir/values/types.js";
import type { Region } from "#compiler/ir/region.js";
import type {
  RegionCompletionContext,
  NestedRegion
} from "#compiler/ir/node.js";
import {
  ControlBase,
  type BranchHint
} from "./definition.js";

export type IfControlArgs = Readonly<{
  condition: ValueId;
  hint?: BranchHint;
  output?: ValueId;
  thenBody: Region;
  elseBody?: Region;
}>;

export class IfControl extends ControlBase {
  static readonly kind = "if";
  readonly kind = IfControl.kind;
  readonly condition: ValueId;
  declare readonly hint?: BranchHint;
  declare readonly output?: ValueId;
  readonly thenBody: Region;
  declare readonly elseBody?: Region;
  readonly operands: readonly [ValueId];
  readonly nestedBodies: readonly NestedRegion[];
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

  completes(context: RegionCompletionContext): boolean {
    return ifCompletes(this.thenBody, this.elseBody, context);
  }

  mapBodies(map: (body: Region) => Region): IfControl {
    return IfControl.create({
      condition: this.condition,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.output === undefined ? {} : { output: this.output }),
      thenBody: map(this.thenBody),
      ...(this.elseBody === undefined ? {} : { elseBody: map(this.elseBody) })
    });
  }
}

export const ifControl = IfControl;

function ifCompletes(
  thenBody: Region,
  elseBody: Region | undefined,
  context: RegionCompletionContext
): boolean {
  return elseBody !== undefined &&
    context.regionCompletes(thenBody) &&
    context.regionCompletes(elseBody);
}

function nestedBody(body: Region, role: string): NestedRegion {
  return { body, role, scope: { kind: "ordinary" } };
}
