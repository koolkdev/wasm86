import { assert } from "#common/assert.js";
import { noStorageEffects } from "#compiler/ir/effects.js";
import type { Region } from "#compiler/ir/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type {
  BranchHint,
  ControlDefinition,
  ControlNodeBase
} from "./definition.js";

export type IfControlArgs = Readonly<{
  condition: ValueId;
  hint?: BranchHint;
  output?: ValueId;
  thenBody: Region;
  elseBody?: Region;
}>;

export type IfControl = ControlNodeBase & Readonly<{
  kind: "if";
  condition: ValueId;
  hint?: BranchHint;
  output?: ValueId;
  thenBody: Region;
  elseBody?: Region;
}>;

export const ifControl: ControlDefinition<IfControlArgs, IfControl> = {
  kind: "if",
  create: ({ condition, hint, output, thenBody, elseBody }) => {
    assert(
      output === undefined || elseBody !== undefined,
      "value-producing if is missing its else body"
    );
    const control = {
      category: "control" as const,
      kind: "if" as const,
      condition,
      thenBody
    };

    return {
      ...control,
      ...(hint === undefined ? {} : { hint }),
      ...(output === undefined ? {} : { output }),
      ...(elseBody === undefined ? {} : { elseBody })
    };
  },
  describe: (control) => ({
    operands: [control.condition],
    outputs: control.output === undefined ? [] : [control.output],
    nestedBodies: [
      {
        body: control.thenBody,
        role: "thenBody",
        scope: { kind: "ordinary" }
      },
      ...(control.elseBody === undefined
        ? []
        : [{
            body: control.elseBody,
            role: "elseBody",
            scope: { kind: "ordinary" as const }
          }])
    ],
    effects: noStorageEffects
  }),
  mapBodies: (control, map) => ifControl.create({
    condition: control.condition,
    ...(control.hint === undefined ? {} : { hint: control.hint }),
    ...(control.output === undefined ? {} : { output: control.output }),
    thenBody: map(control.thenBody),
    ...(control.elseBody === undefined
      ? {}
      : { elseBody: map(control.elseBody) })
  }),
  completes: (control, context) =>
    control.elseBody !== undefined &&
    context.regionCompletes(control.thenBody) &&
    context.regionCompletes(control.elseBody)
};
