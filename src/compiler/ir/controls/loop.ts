import { noStorageEffects } from "#compiler/ir/effects.js";
import type { Region } from "#compiler/ir/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ControlDefinition, ControlNodeBase } from "./definition.js";

// One loop-carried value, seeded at loop entry and read inside the body through
// its scoped `loopInput` value.
export type LoopCarriedValue = Readonly<{
  seed: ValueId;
  loopInput: ValueId;
}>;

// Runs its body until the body falls through. A loopContinue inside the body
// rewrites the carried values and takes the back edge.
export type LoopControlArgs = Readonly<{
  carried: readonly LoopCarriedValue[];
  body: Region;
}>;

export type LoopControl = ControlNodeBase &
  Readonly<{
    kind: "loop";
    carried: readonly LoopCarriedValue[];
    body: Region;
  }>;

export const loopControl: ControlDefinition<LoopControlArgs, LoopControl> = {
  kind: "loop",
  create: ({ carried, body }) => ({
    category: "control",
    kind: "loop",
    carried,
    body
  }),
  describe: (control) => ({
    operands: control.carried.map((value) => value.seed),
    outputs: [],
    nestedBodies: [
      {
        body: control.body,
        role: "body",
        scope: {
          kind: "loop",
          inputs: control.carried.map((value) => value.loopInput)
        }
      }
    ],
    effects: noStorageEffects
  }),
  mapBodies: (control, map) =>
    loopControl.create({
      carried: control.carried,
      body: map(control.body)
    }),
  completes: () => false
};

export type LoopContinueControlArgs = Readonly<{
  updates: readonly ValueId[];
}>;

export type LoopContinueControl = ControlNodeBase &
  Readonly<{
    kind: "loopContinue";
    updates: readonly ValueId[];
  }>;

export const loopContinueControl: ControlDefinition<LoopContinueControlArgs, LoopContinueControl> =
  {
    kind: "loopContinue",
    create: ({ updates }) => ({
      category: "control",
      kind: "loopContinue",
      updates
    }),
    describe: (control) => ({
      operands: control.updates,
      outputs: [],
      nestedBodies: [],
      effects: noStorageEffects
    }),
    mapBodies: (control) => control,
    completes: () => true
  };
