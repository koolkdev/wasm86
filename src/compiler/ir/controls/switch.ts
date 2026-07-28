import { assert } from "#common/assert.js";
import { noStorageEffects } from "#compiler/ir/effects.js";
import type { Region } from "#compiler/ir/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ControlDefinition, ControlNodeBase } from "./definition.js";

export type SwitchCase = Readonly<{
  // Every match routes to this one body without repeating it.
  matches: readonly number[];
  body: Region;
}>;

// Matches lower to a dense br_table, so they stay byte-sized.
export const maxSwitchMatch = 255;

// Selects one body by selector match, the default when none matches. A
// value-producing switch joins the selected body's fallthrough result through
// `output`; a control-only switch has neither arm results nor an output. The
// backend derives the dense br_table from the match values during emission.
export type SwitchControlArgs = Readonly<{
  selector: ValueId;
  output?: ValueId;
  cases: readonly SwitchCase[];
  defaultBody: Region;
}>;

export type SwitchControl = ControlNodeBase &
  Readonly<{
    kind: "switch";
    selector: ValueId;
    output?: ValueId;
    cases: readonly SwitchCase[];
    defaultBody: Region;
  }>;

export const switchControl: ControlDefinition<SwitchControlArgs, SwitchControl> = {
  kind: "switch",
  create: ({ selector, output, cases, defaultBody }) => {
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
  },
  describe: (control) => ({
    operands: [control.selector],
    outputs: control.output === undefined ? [] : [control.output],
    nestedBodies: [
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
    ],
    effects: noStorageEffects
  }),
  mapBodies: (control, map) =>
    switchControl.create({
      selector: control.selector,
      ...(control.output === undefined ? {} : { output: control.output }),
      cases: control.cases.map((entry) => ({
        matches: entry.matches,
        body: map(entry.body)
      })),
      defaultBody: map(control.defaultBody)
    }),
  completes: (control, context) =>
    control.cases.every((entry) => context.regionCompletes(entry.body)) &&
    context.regionCompletes(control.defaultBody)
};
