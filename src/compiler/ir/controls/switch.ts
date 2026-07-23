import type { ValueId } from "#compiler/ir/values/types.js";
import type { Region } from "#compiler/ir/region.js";
import type {
  RegionCompletionContext,
  NestedRegion
} from "#compiler/ir/node.js";
import { ControlBase } from "./definition.js";

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

export class SwitchControl extends ControlBase {
  static readonly kind = "switch";
  readonly kind = SwitchControl.kind;
  readonly selector: ValueId;
  declare readonly output?: ValueId;
  readonly cases: readonly SwitchCase[];
  readonly defaultBody: Region;
  readonly operands: readonly [ValueId];
  readonly nestedBodies: readonly NestedRegion[];
  readonly outputs: readonly ValueId[];

  private constructor({
    selector,
    output,
    cases,
    defaultBody
  }: SwitchControlArgs) {
    super();
    this.selector = selector;
    if (output !== undefined) {
      this.output = output;
    }
    this.cases = cases;
    this.defaultBody = defaultBody;
    this.operands = [selector];
    this.nestedBodies = [
      ...cases.map((entry, index): NestedRegion => ({
        body: entry.body,
        role: `case[${index}]`,
        scope: { kind: "ordinary" }
      })),
      {
        body: defaultBody,
        role: "default",
        scope: { kind: "ordinary" }
      }
    ];
    this.outputs = output === undefined ? [] : [output];
  }

  static create(args: SwitchControlArgs): SwitchControl {
    return new SwitchControl(args);
  }

  completes(context: RegionCompletionContext): boolean {
    return this.cases.every((entry) => context.regionCompletes(entry.body)) &&
      context.regionCompletes(this.defaultBody);
  }

  mapBodies(map: (body: Region) => Region): SwitchControl {
    return SwitchControl.create({
      selector: this.selector,
      ...(this.output === undefined ? {} : { output: this.output }),
      cases: this.cases.map((entry): SwitchCase => ({
        matches: entry.matches,
        body: map(entry.body)
      })),
      defaultBody: map(this.defaultBody)
    });
  }
}

export const switchControl = SwitchControl;
