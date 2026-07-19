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

export type SwitchCase = Readonly<{ match: number; body: Body }>;

// Matches lower to a dense br_table, so they stay byte-sized.
export const maxSwitchMatch = 255;

// Selects one body by selector match, the default when none matches; the
// selected body's fallthrough result becomes `output`. The occurrence derives
// the dense br_table from the match values during emission.
export type SwitchControlArgs = Readonly<{
  selector: ValueId;
  // Required until a control-only switch has a producer.
  output: ValueId;
  cases: readonly SwitchCase[];
  defaultBody: Body;
}>;

export class SwitchControl extends ControlBase {
  static readonly kind = "switch";
  readonly kind = SwitchControl.kind;
  readonly selector: ValueId;
  readonly output: ValueId;
  readonly cases: readonly SwitchCase[];
  readonly defaultBody: Body;
  readonly operands: readonly [ValueId];
  readonly nestedBodies: readonly NestedBody[];
  readonly outputs: readonly [ValueId];

  private constructor({
    selector,
    output,
    cases,
    defaultBody
  }: SwitchControlArgs) {
    super();
    this.selector = selector;
    this.output = output;
    this.cases = cases;
    this.defaultBody = defaultBody;
    this.operands = [selector];
    this.nestedBodies = [
      ...cases.map((entry, index): NestedBody => ({
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
    this.outputs = [output];
  }

  static create(args: SwitchControlArgs): SwitchControl {
    return new SwitchControl(args);
  }

  completes(context: BodyCompletionContext): boolean {
    return this.cases.every((entry) => context.bodyCompletes(entry.body)) &&
      context.bodyCompletes(this.defaultBody);
  }

  mapBodies(map: (body: Body) => Body): SwitchControl {
    return SwitchControl.create({
      selector: this.selector,
      output: this.output,
      cases: this.cases.map((entry) => ({
        match: entry.match,
        body: map(entry.body)
      })),
      defaultBody: map(this.defaultBody)
    });
  }

  emit(target: ControlEmitTarget, values: ValueUseEmitter): void {
    const outputLocal = target.controlOutputLocal(this.output);
    const caseCount = this.cases.length;

    // Open order: join, default, case n-1 .. case 0.
    for (let index = 0; index <= caseCount + 1; index += 1) {
      target.body.block();
    }

    values.emitUse(this.selector);
    target.emitCaptures();
    target.body.brTable(switchLabelDepths(this.cases), caseCount);

    this.cases.forEach((entry, index) => {
      target.body.endBlock();
      target.withNestedControl(
        () => target.emitBody(entry.body, outputLocal),
        caseCount - index + 1
      );
      target.body.br(caseCount - index);
    });

    target.body.endBlock();
    target.withNestedControl(
      () => target.emitBody(this.defaultBody, outputLocal),
      1
    );
    target.body.endBlock();

    if (outputLocal !== undefined) {
      target.markControlOutput(this.output);
    }
  }
}

export const switchControl = SwitchControl;

function switchLabelDepths(cases: readonly SwitchCase[]): number[] {
  const size = cases.reduce((max, entry) => Math.max(max, entry.match + 1), 0);
  const table = new Array<number>(size).fill(cases.length);

  for (const [depth, entry] of cases.entries()) {
    table[entry.match] = depth;
  }
  return table;
}
