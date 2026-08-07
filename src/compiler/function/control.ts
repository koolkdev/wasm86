import { assert } from "#common/assert.js";
import type { Invocation } from "#compiler/function/invocation.js";
import type { Region } from "#compiler/function/region.js";
import { noStorageEffects, type StorageEffects } from "#compiler/function/storage.js";
import type { AnyNarrowInteger, BitValue, ValueRef } from "#compiler/function/values.js";

export type BranchHint = "unlikely" | "likely";

export type IfControlArgs = Readonly<{
  condition: BitValue;
  hint?: BranchHint;
  output?: ValueRef;
  thenBody: Region;
  elseBody?: Region;
}>;

export type IfControl = Readonly<{ category: "control"; kind: "if" }> & IfControlArgs;

export function ifControl({
  condition,
  hint,
  output,
  thenBody,
  elseBody
}: IfControlArgs): IfControl {
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
}

// One loop-carried value, seeded at loop entry and read inside the body through
// its scoped `loopInput` value.
export type LoopCarriedValue = Readonly<{
  seed: ValueRef;
  loopInput: ValueRef;
}>;

// Runs its body until the body falls through. A loopContinue inside the body
// rewrites the carried values and takes the back edge.
export type LoopControlArgs = Readonly<{
  carried: readonly LoopCarriedValue[];
  body: Region;
}>;

export type LoopControl = Readonly<{ category: "control"; kind: "loop" }> & LoopControlArgs;

export function loopControl({ carried, body }: LoopControlArgs): LoopControl {
  return {
    category: "control",
    kind: "loop",
    carried,
    body
  };
}

export type LoopContinueControlArgs = Readonly<{
  updates: readonly ValueRef[];
}>;

export type LoopContinueControl = Readonly<{ category: "control"; kind: "loopContinue" }> &
  LoopContinueControlArgs;

export function loopContinueControl({ updates }: LoopContinueControlArgs): LoopContinueControl {
  return {
    category: "control",
    kind: "loopContinue",
    updates
  };
}

export type ReturnSource =
  | Readonly<{ kind: "values"; values: readonly ValueRef[] }>
  | Readonly<{ kind: "invocation"; invocation: Invocation }>;

export type ReturnControlArgs = Readonly<{
  source: ReturnSource;
}>;

export type ReturnControl = Readonly<{ category: "control"; kind: "return" }> & ReturnControlArgs;

export function returnControl({ source }: ReturnControlArgs): ReturnControl {
  return {
    category: "control",
    kind: "return",
    source: source.kind === "values" ? { kind: "values", values: [...source.values] } : source
  };
}

export type SwitchCase = Readonly<{
  // Every match routes to this one body without repeating it.
  matches: readonly number[];
  body: Region;
}>;

// Matches lower to a dense br_table, so they stay byte-sized.
export const maxSwitchMatch = 255;

// Selects one body by selector match, the default when none matches. A
// value-producing switch joins the selected body's fallthrough result through
// `output`; a control-only switch has neither arm results nor an output.
// A target can derive its preferred dispatch representation from the match values.
export type SwitchControlArgs = Readonly<{
  selector: AnyNarrowInteger;
  output?: ValueRef;
  cases: readonly SwitchCase[];
  defaultBody: Region;
}>;

export type SwitchControl = Readonly<{ category: "control"; kind: "switch" }> & SwitchControlArgs;

export function switchControl({
  selector,
  output,
  cases,
  defaultBody
}: SwitchControlArgs): SwitchControl {
  const matches = new Set<number>();

  for (const [caseIndex, entry] of cases.entries()) {
    assert(entry.matches.length > 0, `switch case ${caseIndex} has no matches`);
    for (const match of entry.matches) {
      assert(
        Number.isInteger(match) && match >= 0 && match <= maxSwitchMatch,
        `switch case match ${match} is not an integer in [0, ${maxSwitchMatch}]`
      );
      assert(!matches.has(match), `switch has duplicate case match ${match}`);
      matches.add(match);
    }
  }

  return {
    category: "control",
    kind: "switch",
    selector,
    ...(output === undefined ? {} : { output }),
    cases,
    defaultBody
  };
}

export type Control = IfControl | LoopContinueControl | LoopControl | ReturnControl | SwitchControl;

export function controlOperands(control: Control): readonly ValueRef[] {
  switch (control.kind) {
    case "if":
      return [control.condition];
    case "switch":
      return [control.selector];
    case "loop":
      return control.carried.map((value) => value.seed);
    case "loopContinue":
      return control.updates;
    case "return":
      return control.source.kind === "values"
        ? control.source.values
        : control.source.invocation.arguments;
  }
}

export function controlOutput(control: Control): ValueRef | undefined {
  switch (control.kind) {
    case "if":
    case "switch":
      return control.output;
    case "loop":
    case "loopContinue":
    case "return":
      return undefined;
  }
}

// A region owned by a control. Loop bodies additionally declare the values
// scoped to the loop's back edge.
export type ControlRegion = Readonly<{
  body: Region;
  role: string;
  scope: Readonly<{ kind: "ordinary" }> | Readonly<{ kind: "loop"; inputs: readonly ValueRef[] }>;
}>;

export function controlRegions(control: Control): readonly ControlRegion[] {
  switch (control.kind) {
    case "if":
      return [
        {
          body: control.thenBody,
          role: "thenBody",
          scope: { kind: "ordinary" }
        },
        ...(control.elseBody === undefined
          ? []
          : [
              {
                body: control.elseBody,
                role: "elseBody",
                scope: { kind: "ordinary" as const }
              }
            ])
      ];
    case "switch":
      return [
        ...control.cases.map((entry, index) => ({
          body: entry.body,
          role: `case[${index}]`,
          scope: { kind: "ordinary" as const }
        })),
        {
          body: control.defaultBody,
          role: "default",
          scope: { kind: "ordinary" }
        }
      ];
    case "loop":
      return [
        {
          body: control.body,
          role: "body",
          scope: {
            kind: "loop",
            inputs: control.carried.map((value) => value.loopInput)
          }
        }
      ];
    case "loopContinue":
    case "return":
      return [];
  }
}

export function controlEffects(control: Control): StorageEffects {
  return control.kind === "return" && control.source.kind === "invocation"
    ? control.source.invocation.target.effects
    : noStorageEffects;
}

export function controlCompletes(control: Control): boolean {
  switch (control.kind) {
    case "if":
      return (
        control.elseBody !== undefined && control.thenBody.completes && control.elseBody.completes
      );
    case "switch":
      return control.cases.every((entry) => entry.body.completes) && control.defaultBody.completes;
    case "loop":
      return false;
    case "loopContinue":
    case "return":
      return true;
  }
}
