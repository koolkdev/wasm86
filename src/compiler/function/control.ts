import { assert } from "#common/assert.js";
import type { Invocation } from "#compiler/function/invocation.js";
import type { Region } from "#compiler/function/region.js";
import { noStorageEffects, type StorageEffects } from "#compiler/function/storage.js";
import type { AnyNarrowInteger, BitValue, ValueRef } from "#compiler/function/values.js";

type ControlNode<Kind extends string> = Readonly<{
  category: "control";
  kind: Kind;
}>;

export type BranchHint = "unlikely" | "likely";

type IfControlBase = Readonly<{
  condition: BitValue;
  hint?: BranchHint;
  thenBody: Region;
}>;

export type IfControlArgs =
  | (IfControlBase & Readonly<{ output?: undefined; elseBody?: Region }>)
  | (IfControlBase & Readonly<{ output: ValueRef; elseBody: Region }>);

export type IfControl = ControlNode<"if"> & IfControlArgs;

// One loop-carried value, seeded at loop entry and read inside the body through
// its scoped loop input.
export type LoopCarriedValue = Readonly<{
  seed: ValueRef;
  loopInput: ValueRef;
}>;

export type LoopControlArgs = Readonly<{
  carried: readonly LoopCarriedValue[];
  body: Region;
}>;

export type LoopControl = ControlNode<"loop"> & LoopControlArgs;

export type LoopContinueControlArgs = Readonly<{
  updates: readonly ValueRef[];
}>;

export type LoopContinueControl = ControlNode<"loopContinue"> & LoopContinueControlArgs;

export type ReturnSource =
  | Readonly<{ kind: "values"; values: readonly ValueRef[] }>
  | Readonly<{ kind: "invocation"; invocation: Invocation }>;

export type ReturnControlArgs = Readonly<{
  source: ReturnSource;
}>;

export type ReturnControl = ControlNode<"return"> & ReturnControlArgs;

export type SwitchCase = Readonly<{
  matches: readonly number[];
  body: Region;
}>;

export type SwitchControlArgs = Readonly<{
  selector: AnyNarrowInteger;
  output?: ValueRef;
  cases: readonly SwitchCase[];
  defaultBody: Region;
}>;

export type SwitchControl = ControlNode<"switch"> & SwitchControlArgs;

export type Control = IfControl | LoopContinueControl | LoopControl | ReturnControl | SwitchControl;

// `loopInputs` is present for a loop body, including a loop that carries no values.
export type ControlRegion = Readonly<{
  body: Region;
  loopInputs?: readonly ValueRef[];
}>;

export type ControlDescription = Readonly<{
  operands: readonly ValueRef[];
  output: ValueRef | undefined;
  regions: readonly ControlRegion[];
  effects: StorageEffects;
}>;

function ifControl(args: IfControlArgs): IfControl {
  return {
    category: "control",
    kind: "if",
    ...args
  };
}

function loop(args: LoopControlArgs): LoopControl {
  return {
    category: "control",
    kind: "loop",
    ...args
  };
}

function loopContinue(args: LoopContinueControlArgs): LoopContinueControl {
  return {
    category: "control",
    kind: "loopContinue",
    ...args
  };
}

function returnControl(args: ReturnControlArgs): ReturnControl {
  return {
    category: "control",
    kind: "return",
    ...args
  };
}

function switchControl(args: SwitchControlArgs): SwitchControl {
  const matches = new Set<number>();

  for (const [caseIndex, entry] of args.cases.entries()) {
    assert(entry.matches.length > 0, `switch case ${caseIndex} has no matches`);
    for (const match of entry.matches) {
      assert(!matches.has(match), `switch has duplicate case match ${match}`);
      matches.add(match);
    }
  }

  return {
    category: "control",
    kind: "switch",
    ...args
  };
}

function describe(control: Control): ControlDescription {
  switch (control.kind) {
    case "if":
      return {
        operands: [control.condition],
        output: control.output,
        regions: [
          {
            body: control.thenBody
          },
          ...(control.elseBody === undefined
            ? []
            : [
                {
                  body: control.elseBody
                }
              ])
        ],
        effects: noStorageEffects
      };
    case "switch":
      return {
        operands: [control.selector],
        output: control.output,
        regions: [
          ...control.cases.map((entry) => ({
            body: entry.body
          })),
          {
            body: control.defaultBody
          }
        ],
        effects: noStorageEffects
      };
    case "loop":
      return {
        operands: control.carried.map((value) => value.seed),
        output: undefined,
        regions: [
          {
            body: control.body,
            loopInputs: control.carried.map((value) => value.loopInput)
          }
        ],
        effects: noStorageEffects
      };
    case "loopContinue":
      return {
        operands: control.updates,
        output: undefined,
        regions: [],
        effects: noStorageEffects
      };
    case "return":
      return {
        operands:
          control.source.kind === "values"
            ? control.source.values
            : control.source.invocation.arguments,
        output: undefined,
        regions: [],
        effects:
          control.source.kind === "invocation"
            ? control.source.invocation.target.effects
            : noStorageEffects
      };
  }
}

export const Control = {
  if: ifControl,
  loop,
  loopContinue,
  return: returnControl,
  switch: switchControl,
  describe
} as const;
