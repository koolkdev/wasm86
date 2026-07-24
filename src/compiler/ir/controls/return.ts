import { noStorageEffects } from "#compiler/ir/effects.js";
import {
  Invocation,
  invocationInputs
} from "#compiler/ir/invocation.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type {
  ControlDefinition,
  ControlNodeBase
} from "./definition.js";

export type ReturnSource =
  | Readonly<{ kind: "values"; values: readonly ValueId[] }>
  | Readonly<{ kind: "invocation"; invocation: Invocation }>;

export type ReturnControlArgs = Readonly<{ source: ReturnSource }>;

export type ReturnControl = ControlNodeBase & Readonly<{
  kind: "return";
  source: ReturnSource;
}>;

export const returnControl: ControlDefinition<
  ReturnControlArgs,
  ReturnControl
> = {
  kind: "return",
  create: ({ source }) => ({
    category: "control",
    kind: "return",
    source: source.kind === "values"
      ? { kind: "values", values: [...source.values] }
      : source
  }),
  describe: (control) => {
    const { source } = control;

    return {
      operands: source.kind === "values"
        ? source.values
        : invocationInputs(source.invocation).map((input) => input.value),
      outputs: [],
      nestedBodies: [],
      effects: source.kind === "values"
        ? noStorageEffects
        : source.invocation.target.effects
    };
  },
  mapBodies: (control) => control,
  completes: () => true
};
