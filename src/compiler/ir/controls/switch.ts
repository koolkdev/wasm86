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

export type SwitchCase = Readonly<{
  // Every match routes to this one body without repeating it.
  matches: readonly number[];
  body: Body;
}>;

// Matches lower to a dense br_table, so they stay byte-sized.
export const maxSwitchMatch = 255;

// Selects one body by selector match, the default when none matches. A
// value-producing switch joins the selected body's fallthrough result through
// `output`; a control-only switch has neither arm results nor an output. The
// occurrence derives the dense br_table from the match values during emission.
export type SwitchControlArgs = Readonly<{
  selector: ValueId;
  output?: ValueId;
  cases: readonly SwitchCase[];
  defaultBody: Body;
}>;

export class SwitchControl extends ControlBase {
  static readonly kind = "switch";
  readonly kind = SwitchControl.kind;
  readonly selector: ValueId;
  declare readonly output?: ValueId;
  readonly cases: readonly SwitchCase[];
  readonly defaultBody: Body;
  readonly operands: readonly [ValueId];
  readonly nestedBodies: readonly NestedBody[];
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
    this.outputs = output === undefined ? [] : [output];
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
      ...(this.output === undefined ? {} : { output: this.output }),
      cases: this.cases.map((entry): SwitchCase => ({
        matches: entry.matches,
        body: map(entry.body)
      })),
      defaultBody: map(this.defaultBody)
    });
  }

  emit(target: ControlEmitTarget, values: ValueUseEmitter): void {
    const outputLocal = this.output === undefined
      ? undefined
      : target.controlOutputLocal(this.output);
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

    if (this.output !== undefined && outputLocal !== undefined) {
      target.markControlOutput(this.output);
    }
    if (this.completes(target)) {
      target.sealCompletedStructuredControl();
    }
  }
}

export const switchControl = SwitchControl;

function switchLabelDepths(cases: readonly SwitchCase[]): number[] {
  let size = 0;

  for (const entry of cases) {
    for (const match of entry.matches) {
      size = Math.max(size, match + 1);
    }
  }
  const table = new Array<number>(size).fill(cases.length);

  for (const [depth, entry] of cases.entries()) {
    for (const match of entry.matches) {
      table[match] = depth;
    }
  }
  return table;
}
